import type { Database } from '@agent-tasks/database';
import { executions, tasks } from '@agent-tasks/database';
import { nextOccurrence, scheduleSchema } from '@agent-tasks/shared';
import { and, eq, lt, sql as raw } from 'drizzle-orm';

export interface DueTask {
  taskId: string;
  ownerId: string;
  occurrence: Date;
  executionId: string;
}

/**
 * One scheduler tick, in a single transaction.
 *
 * `FOR UPDATE SKIP LOCKED` makes several workers safe against each other; the unique
 * index on (task_id, scheduled_for) makes a tick idempotent even if two workers race
 * or a worker dies between insert and commit. `next_run_at` moves in the same
 * transaction as the execution insert, so a crash cannot double-book an occurrence.
 */
export async function scheduleDueExecutions(db: Database, now: Date = new Date()): Promise<DueTask[]> {
  return db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string; owner_id: string; schedule: unknown; next_run_at: Date }>(raw`
      select id, owner_id, schedule, next_run_at
      from tasks
      where enabled = true and next_run_at is not null and next_run_at <= ${now.toISOString()}
      order by next_run_at asc
      limit 25
      for update skip locked
    `);

    const created: DueTask[] = [];
    for (const row of due.rows) {
      const occurrence = new Date(row.next_run_at);
      const schedule = scheduleSchema.parse(row.schedule);
      const next = nextOccurrence(schedule, occurrence);
      const inserted = await tx.execute<{ id: string }>(raw`
        insert into executions (id, task_id, owner_id, task_title, status, trigger, scheduled_for, model, provider_id)
        select ${crypto.randomUUID()}, t.id, t.owner_id, t.title, 'queued', 'schedule', ${occurrence.toISOString()}, t.model, t.provider_id
        from tasks t where t.id = ${row.id}
        on conflict (task_id, scheduled_for) do nothing
        returning id
      `);
      await tx.execute(raw`
        update tasks set next_run_at = ${next ? next.toISOString() : null}, last_run_at = ${occurrence.toISOString()}, updated_at = now()
        where id = ${row.id}
      `);
      const executionId = inserted.rows[0]?.id;
      if (executionId) created.push({ taskId: row.id, ownerId: row.owner_id, occurrence, executionId });
    }
    return created;
  });
}

/**
 * Lease-based claim. Two workers can receive the same job (at-least-once delivery);
 * only one of them flips `queued` to `running`.
 */
export async function claimExecution(
  db: Database,
  executionId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(raw`
    update executions
    set status = 'running',
        worker_id = ${workerId},
        started_at = coalesce(started_at, now()),
        finished_at = null,
        lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
    where id = ${executionId} and status = 'queued'
    returning id
  `);
  return rows.rows.length > 0;
}

export async function heartbeat(db: Database, executionId: string, leaseSeconds: number): Promise<void> {
  await db.execute(raw`update executions set lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval where id = ${executionId} and status = 'running'`);
}

export async function isCancelRequested(db: Database, executionId: string): Promise<boolean> {
  const rows = await db.execute<{ cancel_requested: boolean }>(raw`select cancel_requested from executions where id = ${executionId}`);
  return rows.rows[0]?.cancel_requested === true;
}

/**
 * Number of the owner's executions that are running right now, excluding
 * `excludeExecutionId` (the execution asking the question: it is already `running`).
 */
export async function countRunningForOwner(db: Database, ownerId: string, excludeExecutionId?: string): Promise<number> {
  const exclude = excludeExecutionId ? raw`and id <> ${excludeExecutionId}` : raw`and true`;
  const rows = await db.execute<{ count: number }>(raw`
    select count(*)::int as count from executions
    where owner_id = ${ownerId} and status = 'running' ${exclude}
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * Number of the owner's executions created in the last 24 hours, excluding
 * `excludeExecutionId` (the execution asking the question: its own row already exists).
 */
export async function countExecutionsToday(db: Database, ownerId: string, excludeExecutionId?: string): Promise<number> {
  const exclude = excludeExecutionId ? raw`and id <> ${excludeExecutionId}` : raw`and true`;
  const rows = await db.execute<{ count: number }>(raw`
    select count(*)::int as count from executions
    where owner_id = ${ownerId} and created_at > now() - interval '24 hours' ${exclude}
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * Crash recovery: a `running` execution whose lease expired lost its worker.
 * It is put back to `queued` (at-least-once) unless cancellation was requested,
 * in which case it is closed as cancelled.
 */
export async function recoverStaleExecutions(db: Database, now: Date = new Date()): Promise<{ requeued: string[]; cancelled: string[] }> {
  const stale = await db
    .select({ id: executions.id, cancelRequested: executions.cancelRequested, ownerId: executions.ownerId })
    .from(executions)
    .where(and(eq(executions.status, 'running'), lt(executions.leaseExpiresAt, now)));
  const requeued: string[] = [];
  const cancelled: string[] = [];
  for (const execution of stale) {
    if (execution.cancelRequested) {
      await db.update(executions).set({ status: 'cancelled', finishedAt: now, error: 'cancelled while the worker was down' }).where(eq(executions.id, execution.id));
      cancelled.push(execution.id);
    } else {
      await db.update(executions).set({ status: 'queued', workerId: null, leaseExpiresAt: null, updatedAt: now }).where(eq(executions.id, execution.id));
      requeued.push(execution.id);
    }
  }
  return { requeued, cancelled };
}

/** A queued execution is re-sent only after it has not been touched for this long. */
// Longer than the executor's maximum retry backoff (30 s * attempt), so a sweep never
// overtakes a deliberately delayed retry.
export const QUEUED_SWEEP_MIN_AGE_SECONDS = 180;
/** Large enough that a normal backlog drains in a few pages, small enough to bound one tick. */
export const QUEUED_SWEEP_PAGE_SIZE = 100;

export interface QueuedExecutionCursor {
  updatedAt: Date;
  id: string;
}

/**
 * One page of `queued` executions that have not been (re-)enqueued for at least
 * `olderThanSeconds`.
 *
 * The sweep must not stop at the first page: a commit followed by a failed `boss.send`
 * can orphan any number of rows. Keyset pagination on `(updated_at, id)` is stable while
 * earlier pages are re-enqueued (which bumps `updated_at`), unlike LIMIT/OFFSET.
 */
export async function queuedExecutionPage(
  db: Database,
  options: { olderThanSeconds?: number; pageSize?: number; after?: QueuedExecutionCursor | null } = {},
): Promise<{ ids: string[]; cursor: QueuedExecutionCursor | null }> {
  const olderThanSeconds = options.olderThanSeconds ?? QUEUED_SWEEP_MIN_AGE_SECONDS;
  const pageSize = options.pageSize ?? QUEUED_SWEEP_PAGE_SIZE;
  const afterClause = options.after
    ? raw`and (updated_at, id) > (${options.after.updatedAt.toISOString()}::timestamptz, ${options.after.id}::uuid)`
    : raw`and true`;
  const rows = await db.execute<{ id: string; updated_at: Date | string }>(raw`
    select id, updated_at from executions
    where status = 'queued'
      and updated_at <= now() - (${olderThanSeconds} || ' seconds')::interval
      ${afterClause}
    order by updated_at asc, id asc
    limit ${pageSize}
  `);
  const ids = rows.rows.map((row) => row.id);
  const last = rows.rows[rows.rows.length - 1];
  return {
    ids,
    cursor: last ? { updatedAt: new Date(last.updated_at), id: last.id } : null,
  };
}

export interface QueuedResendResult {
  attempted: number;
  /** Executions whose send failed; they stay `queued` and are retried on the next sweep. */
  failed: string[];
}

/**
 * Walk every stale `queued` execution and send it to pg-boss again. A successful send
 * bumps `updated_at`, so the row is not selected again until it is `olderThanSeconds`
 * old (or until a worker claims it). A failed send deliberately leaves `updated_at`
 * untouched, which is exactly what makes the next sweep retry it.
 *
 * Called both at boot (with `olderThanSeconds: 0`) and from the periodic recovery job.
 */
export async function resendQueuedExecutions(
  db: Database,
  send: (executionId: string) => Promise<unknown>,
  options: { olderThanSeconds?: number; pageSize?: number; maxPages?: number } = {},
): Promise<QueuedResendResult> {
  const pageSize = options.pageSize ?? QUEUED_SWEEP_PAGE_SIZE;
  const maxPages = options.maxPages ?? 100;
  let after: QueuedExecutionCursor | null = null;
  let attempted = 0;
  const failed: string[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const { ids, cursor } = await queuedExecutionPage(db, { olderThanSeconds: options.olderThanSeconds, pageSize, after });
    if (ids.length === 0) break;
    for (const executionId of ids) {
      attempted += 1;
      try {
        await send(executionId);
        await db.update(executions).set({ updatedAt: new Date() }).where(eq(executions.id, executionId));
      } catch {
        failed.push(executionId);
      }
    }
    if (ids.length < pageSize || !cursor) break;
    after = cursor;
  }
  return { attempted, failed };
}

export async function pauseTask(db: Database, taskId: string): Promise<void> {
  await db.update(tasks).set({ enabled: false, nextRunAt: null, updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.enabled, true)));
}

