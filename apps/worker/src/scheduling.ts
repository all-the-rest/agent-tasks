import type { Database } from '@agent-tasks/database';
import { executions, tasks } from '@agent-tasks/database';
import {
  isAfterTaskEndDate,
  isTaskEndConditionReached,
  nextOccurrence,
  scheduleSchema,
  taskEndConditionSchema,
} from '@agent-tasks/shared';
import { and, eq, lt, sql as raw } from 'drizzle-orm';
import { exceededExecutionLimit } from './quota.js';
import type { ExecutionLimits, LimitRefusal } from './quota.js';

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
    // Filter active tasks before LIMIT so long-running tasks cannot monopolize the
    // due-work page. The active check is repeated after locking each task row below.
    const due = await tx.execute<{
      id: string;
      owner_id: string;
      enabled: boolean;
      schedule: unknown;
      next_run_at: Date | null;
      end_condition: unknown;
      scheduled_run_count: number;
      }>(raw`
      select id, owner_id, enabled, schedule, next_run_at, end_condition, scheduled_run_count
      from tasks
      where completed_at is null
        and not exists (
          select 1 from executions e
          where e.task_id = tasks.id and e.status in ('queued', 'running')
        )
        and (
        (enabled = true and next_run_at is not null and next_run_at <= ${now.toISOString()})
        or (
          end_condition->>'type' = 'on_date'
          and (end_condition->>'date')::date < (${now.toISOString()}::timestamptz at time zone timezone)::date
        )
      )
      order by next_run_at asc nulls last
      limit 25
      for update skip locked
    `);

    const created: DueTask[] = [];
    for (const row of due.rows) {
      const endCondition = taskEndConditionSchema.parse(row.end_condition);
      const schedule = scheduleSchema.parse(row.schedule);
      const occurrence = row.next_run_at ? new Date(row.next_run_at) : null;
      const scheduledRunCount = Number(row.scheduled_run_count);
      const endReached = isTaskEndConditionReached(endCondition, {
        timezone: schedule.timezone,
        scheduledRunCount,
        now,
      });
      const occurrencePastEndDate = occurrence !== null && isAfterTaskEndDate(endCondition, schedule.timezone, occurrence);
      const completeTask = () => tx.execute(raw`
        update tasks
        set enabled = false, next_run_at = null, completed_at = coalesce(completed_at, ${now.toISOString()}), updated_at = now()
        where id = ${row.id} and completed_at is null
      `);

      // A date end is inclusive: a delayed occurrence on the selected local date
      // may still be booked, but no later occurrence can be. If the date passed
      // and there is nothing left inside its window, finish without booking.
      if (endCondition.type === 'after_runs' && scheduledRunCount >= endCondition.runs) {
        await completeTask();
        continue;
      }
      // Pausing suppresses all bookings. Still retire date-bounded tasks after
      // their local end date so they do not remain paused-but-incomplete forever.
      if (!row.enabled) {
        if (endReached) await completeTask();
        continue;
      }
      if (endReached && (occurrence === null || occurrencePastEndDate)) {
        await completeTask();
        continue;
      }
      if (!occurrence) continue;
      if (occurrencePastEndDate) {
        await completeTask();
        continue;
      }

      const active = await tx.execute<{ id: string }>(raw`
        select id from executions
        where task_id = ${row.id} and status in ('queued', 'running')
        limit 1
      `);
      // Keep the occurrence due until the current run finishes. The task row lock
      // serializes this check with run-now/follow-up and with other scheduler ticks.
      if (active.rows.length > 0) continue;

      const inserted = await tx.execute<{ id: string }>(raw`
        insert into executions (id, task_id, owner_id, task_title, input_snapshot, status, trigger, scheduled_for, model, provider_id)
        select ${crypto.randomUUID()}, t.id, t.owner_id, t.title, t.prompt, 'queued', 'schedule', ${occurrence.toISOString()}, t.model, t.provider_id
        from tasks t where t.id = ${row.id}
        on conflict (task_id, scheduled_for) do nothing
        returning id
      `);
      const executionId = inserted.rows[0]?.id;
      const nextScheduledRunCount = scheduledRunCount + (executionId ? 1 : 0);
      const runLimitReached =
        endCondition.type === 'after_runs' && nextScheduledRunCount >= endCondition.runs;
      const dateExpired =
        endCondition.type === 'on_date' && isTaskEndConditionReached(endCondition, {
          timezone: schedule.timezone,
          scheduledRunCount: nextScheduledRunCount,
          now,
        });
      const next = nextOccurrence(schedule, occurrence);
      const nextOccurrencePastEndDate = next !== null && isAfterTaskEndDate(endCondition, schedule.timezone, next);
      const dateWindowExhausted = dateExpired && (next === null || nextOccurrencePastEndDate);
      const completed = runLimitReached || dateWindowExhausted || next === null;
      const nextRunAt = completed ? null : next;
      await tx.execute(raw`
        update tasks
        set next_run_at = ${nextRunAt ? nextRunAt.toISOString() : null},
            last_run_at = ${occurrence.toISOString()},
            scheduled_run_count = ${nextScheduledRunCount},
            enabled = case when ${completed} then false else enabled end,
            completed_at = case when ${completed} then coalesce(completed_at, ${now.toISOString()}) else completed_at end,
            updated_at = now()
        where id = ${row.id}
      `);
      if (executionId) created.push({ taskId: row.id, ownerId: row.owner_id, occurrence, executionId });
    }
    return created;
  });
}

export type ClaimExecutionResult =
  | { status: 'claimed' }
  | { status: 'not_claimed' }
  | { status: 'deferred' }
  | { status: 'refused'; reason: LimitRefusal; retryAttempt: number | null };

/**
 * Claim and reserve execution capacity in one transaction. The owner advisory lock
 * serializes per-user and per-task admission across workers; the execution row lock
 * keeps at-least-once delivery from claiming the same execution twice.
 */
export async function claimExecution(
  db: Database,
  executionId: string,
  workerId: string,
  leaseSeconds: number,
  limits: ExecutionLimits,
  maxAttempts: number,
): Promise<ClaimExecutionResult> {
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ owner_id: string; task_id: string; attempt: number; already_admitted_today: boolean }>(raw`
      select owner_id, task_id, attempt,
             coalesce(started_at > now() - interval '24 hours', false) as already_admitted_today
      from executions
      where id = ${executionId} and status = 'queued'
      for update
    `);
    const candidate = candidates.rows[0];
    if (!candidate) return { status: 'not_claimed' };

    await tx.execute(raw`select pg_advisory_xact_lock(hashtext(${candidate.owner_id}))`);
    const counts = await tx.execute<{
      prior_executions_today: number;
      other_running_for_owner: number;
      other_running_for_task: number;
    }>(raw`
      select
        (select count(*)::int from executions
          where owner_id = ${candidate.owner_id}
            and started_at > now() - interval '24 hours'
            and id <> ${executionId}) as prior_executions_today,
        (select count(*)::int from executions
          where owner_id = ${candidate.owner_id}
            and status = 'running'
            and id <> ${executionId}) as other_running_for_owner,
        (select count(*)::int from executions
          where task_id = ${candidate.task_id}
            and status = 'running'
            and id <> ${executionId}) as other_running_for_task
    `);
    if (Number(counts.rows[0]?.other_running_for_task ?? 0) > 0) {
      // This is transient backpressure, not a failed attempt. The executor requeues
      // it after a short delay while preserving the execution's retry budget.
      return { status: 'deferred' };
    }
    const refusal = exceededExecutionLimit(
      {
        priorExecutionsToday: candidate.already_admitted_today
          ? 0
          : Number(counts.rows[0]?.prior_executions_today ?? 0),
        otherRunningForOwner: Number(counts.rows[0]?.other_running_for_owner ?? 0),
      },
      limits,
    );
    if (!refusal) {
      await tx.execute(raw`
        update executions
        set status = 'running',
            worker_id = ${workerId},
            started_at = case
              when started_at is null or started_at <= now() - interval '24 hours' then now()
              else started_at
            end,
            finished_at = null,
            lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
        where id = ${executionId} and status = 'queued'
      `);
      return { status: 'claimed' };
    }

    if (candidate.attempt >= maxAttempts) {
      await tx.execute(raw`
        update executions
        set status = 'failed',
            finished_at = now(),
            lease_expires_at = null,
            error = ${refusal === 'quota' ? 'daily execution quota exceeded' : 'per-user concurrency limit exceeded'}
        where id = ${executionId} and status = 'queued'
      `);
      return { status: 'refused', reason: refusal, retryAttempt: null };
    }

    const retryAttempt = candidate.attempt + 1;
    await tx.execute(raw`
      update executions
      set status = 'queued',
          worker_id = null,
          lease_expires_at = null,
          attempt = ${retryAttempt},
          updated_at = now()
      where id = ${executionId} and status = 'queued'
    `);
    return { status: 'refused', reason: refusal, retryAttempt };
  });
}

export async function heartbeat(db: Database, executionId: string, leaseSeconds: number): Promise<void> {
  await db.execute(raw`update executions set lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval where id = ${executionId} and status = 'running'`);
}

export async function isCancelRequested(db: Database, executionId: string): Promise<boolean> {
  const rows = await db.execute<{ cancel_requested: boolean }>(raw`select cancel_requested from executions where id = ${executionId}`);
  return rows.rows[0]?.cancel_requested === true;
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
