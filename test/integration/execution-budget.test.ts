import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  readExecutionBudget,
  reserveExecutionBudget,
  runMigrations,
} from '@agent-tasks/database';
import type { DatabaseHandle, ExecutionBudgetLimits } from '@agent-tasks/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../helpers/harness';

/**
 * Isolated integration coverage for the durable execution budget. The fixtures
 * are inserted directly (no API/worker) so the test exercises exactly the SQL
 * reservation contract, including concurrent bursts and recovery/retry cycles.
 */

let handle: DatabaseHandle;

const suffix = randomUUID();
const ownerId = `budget-owner-${suffix}`;
const strangerId = `budget-stranger-${suffix}`;
const providerId = randomUUID();
const ownerTaskId = randomUUID();
const strangerTaskId = randomUUID();

const WORKER = 'budget-worker-a';
const LIMITS: ExecutionBudgetLimits = {
  maxToolCalls: 5,
  maxPageVisits: 3,
  maxSearchQueries: 2,
  maxOutputBytes: 10_000,
};

interface StartExecutionOptions {
  ownerId?: string;
  workerId?: string | null;
  status?: string;
  leaseExpiresAt?: Date | null;
  cancelRequested?: boolean;
}

async function startExecution(options: StartExecutionOptions = {}): Promise<string> {
  const id = randomUUID();
  const executionOwner = options.ownerId ?? ownerId;
  const taskId = executionOwner === ownerId ? ownerTaskId : strangerTaskId;
  const status = options.status ?? 'running';
  const workerId = 'workerId' in options ? options.workerId : WORKER;
  const leaseExpiresAt =
    'leaseExpiresAt' in options
      ? options.leaseExpiresAt
      : status === 'running'
        ? new Date(Date.now() + 120_000)
        : null;
  await handle.pool.query(
    `insert into executions
       (id, task_id, owner_id, task_title, status, trigger, attempt, worker_id, lease_expires_at, cancel_requested)
     values ($1, $2, $3, 'Budget fixture', $4, 'manual', 1, $5, $6, $7)`,
    [id, taskId, executionOwner, status, workerId ?? null, leaseExpiresAt, options.cancelRequested ?? false],
  );
  return id;
}

function reserve(
  executionId: string,
  counters: Parameters<typeof reserveExecutionBudget>[1]['counters'],
  options: { ownerId?: string; workerId?: string; limits?: ExecutionBudgetLimits } = {},
) {
  return reserveExecutionBudget(handle.db, {
    executionId,
    ownerId: options.ownerId ?? ownerId,
    workerId: options.workerId ?? WORKER,
    limits: options.limits ?? LIMITS,
    counters,
  });
}

async function requeue(executionId: string): Promise<void> {
  await handle.pool.query(
    `update executions
     set status = 'queued', worker_id = null, lease_expires_at = null, attempt = attempt + 1, updated_at = now()
     where id = $1`,
    [executionId],
  );
}

async function claim(executionId: string, workerId: string, leaseSeconds = 120): Promise<void> {
  await handle.pool.query(
    `update executions
     set status = 'running', worker_id = $2, lease_expires_at = now() + ($3 || ' seconds')::interval, updated_at = now()
     where id = $1`,
    [executionId, workerId, leaseSeconds],
  );
}

async function budgetRowCount(executionId: string): Promise<number> {
  const result = await handle.pool.query<{ count: number }>(
    'select count(*)::int as count from execution_budget_counters where execution_id = $1',
    [executionId],
  );
  return result.rows[0]?.count ?? 0;
}

beforeAll(async () => {
  await runMigrations(TEST_DATABASE_URL);
  handle = createDatabase(TEST_DATABASE_URL, { max: 12 });

  await handle.pool.query('insert into "user" (id, name, email) values ($1, $2, $3), ($4, $5, $6)', [
    ownerId,
    'Budget Owner',
    `${ownerId}@example.com`,
    strangerId,
    'Budget Stranger',
    `${strangerId}@example.com`,
  ]);
  await handle.pool.query(
    `insert into providers (id, name, kind) values ($1, $2, 'openai-compatible')`,
    [providerId, `Budget provider ${suffix}`],
  );
  for (const [id, owner] of [
    [ownerTaskId, ownerId],
    [strangerTaskId, strangerId],
  ] as const) {
    await handle.pool.query(
      `insert into tasks
         (id, owner_id, title, prompt, provider_id, model, schedule, timezone, limits)
       values ($1, $2, 'Budget task', 'Fixture prompt for the execution budget test.', $3, 'budget-model', '{}'::jsonb, 'UTC', '{}'::jsonb)`,
      [id, owner, providerId],
    );
  }
});

afterAll(async () => {
  // Executions and budget rows cascade from the users; the provider is referenced
  // by restrict, so it is removed only after its tasks are gone.
  await handle.pool.query('delete from "user" where id = any($1::text[])', [[ownerId, strangerId]]);
  await handle.pool.query('delete from providers where id = $1', [providerId]);
  await handle.close();
});

describe('durable execution budget', () => {
  it('reserves counters atomically and reports the remaining allowance', async () => {
    const executionId = await startExecution();

    const first = await reserve(executionId, { calls: 1, pages: 1, searches: 1, outputBytes: 400 });
    expect(first).toEqual({
      status: 'reserved',
      usage: { calls: 1, pages: 1, searches: 1, outputBytes: 400 },
      limits: { maxCalls: 5, maxPages: 3, maxSearches: 2, maxOutputBytes: 10_000 },
      remaining: { calls: 4, pages: 2, searches: 1, outputBytes: 9_600 },
    });

    const second = await reserve(executionId, { calls: 2, outputBytes: 600 });
    expect(second).toMatchObject({
      status: 'reserved',
      usage: { calls: 3, pages: 1, searches: 1, outputBytes: 1_000 },
      remaining: { calls: 2, pages: 2, searches: 1, outputBytes: 9_000 },
    });
  });

  it('refuses the reservation that would cross a maximum and never overshoots', async () => {
    const executionId = await startExecution();
    expect((await reserve(executionId, { calls: 4 })).status).toBe('reserved');

    const refused = await reserve(executionId, { calls: 2 });
    expect(refused).toMatchObject({
      status: 'exhausted',
      counter: 'calls',
      usage: { calls: 4 },
      remaining: { calls: 1 },
    });

    expect((await reserve(executionId, { calls: 1 })).status).toBe('reserved');
    const beyond = await reserve(executionId, { calls: 1 });
    expect(beyond).toMatchObject({ status: 'exhausted', counter: 'calls', usage: { calls: 5 } });

    const state = await readExecutionBudget(handle.db, { executionId, ownerId });
    expect(state?.usage.calls).toBe(5);
  });

  it('reserves a multi-counter request all-or-nothing', async () => {
    const executionId = await startExecution();
    await reserve(executionId, { pages: 3 });

    const refused = await reserve(executionId, { calls: 1, pages: 1 });
    expect(refused).toMatchObject({
      status: 'exhausted',
      counter: 'pages',
      usage: { calls: 0, pages: 3 },
    });

    // The refused batch must not have consumed the call.
    const state = await readExecutionBudget(handle.db, { executionId, ownerId });
    expect(state).toMatchObject({ usage: { calls: 0, pages: 3 } });

    const callOnly = await reserve(executionId, { calls: 1 });
    expect(callOnly).toMatchObject({ status: 'reserved', usage: { calls: 1, pages: 3 } });
  });

  it('enforces the maximum under a concurrent burst', async () => {
    const executionId = await startExecution();

    const results = await Promise.all(
      Array.from({ length: 40 }, () => reserve(executionId, { calls: 1 })),
    );
    const reserved = results.filter((result) => result.status === 'reserved');
    const exhausted = results.filter((result) => result.status === 'exhausted');

    expect(reserved).toHaveLength(LIMITS.maxToolCalls);
    expect(exhausted).toHaveLength(40 - LIMITS.maxToolCalls);

    const state = await readExecutionBudget(handle.db, { executionId, ownerId });
    expect(state?.usage.calls).toBe(LIMITS.maxToolCalls);
    expect(state?.remaining.calls).toBe(0);
  });

  it('keeps counters per execution and scopes reads to their owner', async () => {
    const first = await startExecution();
    const second = await startExecution();

    await reserve(first, { calls: 2, searches: 1 });
    expect(await readExecutionBudget(handle.db, { executionId: second, ownerId })).toBeNull();

    await reserve(second, { calls: 1 });
    expect((await readExecutionBudget(handle.db, { executionId: first, ownerId }))?.usage).toMatchObject({
      calls: 2,
      searches: 1,
    });
    expect((await readExecutionBudget(handle.db, { executionId: second, ownerId }))?.usage).toMatchObject({
      calls: 1,
      searches: 0,
    });

    // A different owner can neither read nor reserve against the execution.
    expect(await readExecutionBudget(handle.db, { executionId: first, ownerId: strangerId })).toBeNull();
    const foreign = await reserve(first, { calls: 1 }, { ownerId: strangerId });
    expect(foreign).toEqual({ status: 'denied', reason: 'owner_mismatch' });
  });

  it('denies a foreign worker, an inactive lease, cancellation and a non-running execution', async () => {
    const executionId = await startExecution();

    const wrongWorker = await reserve(executionId, { calls: 1 }, { workerId: 'someone-else' });
    expect(wrongWorker).toEqual({ status: 'denied', reason: 'worker_mismatch' });
    expect(await budgetRowCount(executionId)).toBe(0);

    const expired = await startExecution({ leaseExpiresAt: new Date(Date.now() - 5_000) });
    expect(await reserve(expired, { calls: 1 })).toEqual({ status: 'denied', reason: 'lease_expired' });
    expect(await budgetRowCount(expired)).toBe(0);

    const cancelled = await startExecution({ cancelRequested: true });
    expect(await reserve(cancelled, { calls: 1 })).toEqual({ status: 'denied', reason: 'cancelled' });
    expect(await budgetRowCount(cancelled)).toBe(0);

    const finished = await startExecution({ status: 'completed' });
    expect(await reserve(finished, { calls: 1 })).toEqual({ status: 'denied', reason: 'not_running' });
    expect(await budgetRowCount(finished)).toBe(0);

    const cancelledStatus = await startExecution({ status: 'cancelled' });
    expect(await reserve(cancelledStatus, { calls: 1 })).toEqual({ status: 'denied', reason: 'not_running' });

    const unknown = randomUUID();
    expect(await reserve(unknown, { calls: 1 })).toEqual({ status: 'denied', reason: 'execution_not_found' });
  });

  it('keeps counters across a retry and a crash recovery of the same execution', async () => {
    const executionId = await startExecution({ workerId: WORKER });

    expect((await reserve(executionId, { calls: 2, searches: 1 })).status).toBe('reserved');

    // Deliberate retry: the execution row is reused, only `attempt` and the owner
    // change. A fresh worker must see the already consumed counters.
    await requeue(executionId);
    await claim(executionId, 'worker-b');
    const afterRetry = await reserve(executionId, { calls: 2 }, { workerId: 'worker-b' });
    expect(afterRetry).toMatchObject({
      status: 'reserved',
      usage: { calls: 4, searches: 1 },
      limits: { maxCalls: 5 },
    });

    // Crash recovery: the old worker's lease lapses, the execution is re-queued
    // and claimed by another worker. The counters are still the same row.
    await handle.pool.query(
      `update executions set lease_expires_at = now() - interval '1 second' where id = $1`,
      [executionId],
    );
    expect(await reserve(executionId, { calls: 1 }, { workerId: 'worker-b' })).toEqual({
      status: 'denied',
      reason: 'lease_expired',
    });

    await requeue(executionId);
    await claim(executionId, 'worker-c');
    const afterRecovery = await reserve(executionId, { calls: 1 }, { workerId: 'worker-c' });
    expect(afterRecovery).toMatchObject({
      status: 'reserved',
      usage: { calls: 5, searches: 1 },
      remaining: { calls: 0 },
    });
    expect(await reserve(executionId, { calls: 1 }, { workerId: 'worker-c' })).toMatchObject({
      status: 'exhausted',
      counter: 'calls',
      usage: { calls: 5 },
    });

    const state = await readExecutionBudget(handle.db, { executionId, ownerId });
    expect(state).toMatchObject({ usage: { calls: 5, searches: 1 }, limits: { maxCalls: 5 } });
  });

  it('never widens a budget on retry; a later limit can only tighten it', async () => {
    const executionId = await startExecution();
    await reserve(executionId, { calls: 2 });

    const higher = await reserve(executionId, { calls: 1 }, { limits: { ...LIMITS, maxToolCalls: 100 } });
    expect(higher).toMatchObject({ status: 'reserved', limits: { maxCalls: 5 }, usage: { calls: 3 } });

    const lower = await reserve(executionId, { calls: 1 }, { limits: { ...LIMITS, maxToolCalls: 3 } });
    expect(lower).toMatchObject({
      status: 'exhausted',
      counter: 'calls',
      limits: { maxCalls: 3 },
      usage: { calls: 3 },
    });

    const state = await readExecutionBudget(handle.db, { executionId, ownerId });
    expect(state).toMatchObject({ limits: { maxCalls: 3 }, usage: { calls: 3 } });
  });

  it('accounts output without a cap and tightens a cap introduced on a retry', async () => {
    const uncapped = await startExecution();
    const noCap = await reserve(
      uncapped,
      { outputBytes: 1_000_000 },
      { limits: { ...LIMITS, maxOutputBytes: undefined } },
    );
    expect(noCap).toMatchObject({
      status: 'reserved',
      usage: { outputBytes: 1_000_000 },
      limits: { maxOutputBytes: null },
      remaining: { outputBytes: null },
    });
    expect(
      (
        await reserve(uncapped, { outputBytes: 1_000_000 }, { limits: { ...LIMITS, maxOutputBytes: null } })
      ).status,
    ).toBe('reserved');

    const capped = await startExecution();
    await reserve(capped, { outputBytes: 5_000 }, { limits: { ...LIMITS, maxOutputBytes: undefined } });
    const tightened = await reserve(
      capped,
      { outputBytes: 1 },
      { limits: { ...LIMITS, maxOutputBytes: 4_000 } },
    );
    expect(tightened).toMatchObject({
      status: 'exhausted',
      counter: 'outputBytes',
      usage: { outputBytes: 5_000 },
      limits: { maxOutputBytes: 4_000 },
    });

    const exact = await startExecution();
    expect((await reserve(exact, { outputBytes: 10_000 })).status).toBe('reserved');
    expect(await reserve(exact, { outputBytes: 1 })).toMatchObject({
      status: 'exhausted',
      counter: 'outputBytes',
      usage: { outputBytes: 10_000 },
    });
  });

  it('rejects invalid reservation amounts before touching the database', async () => {
    const executionId = await startExecution();

    await expect(reserve(executionId, {})).rejects.toThrow(RangeError);
    await expect(reserve(executionId, { calls: 0 })).rejects.toThrow(RangeError);
    await expect(reserve(executionId, { calls: -1 })).rejects.toThrow(RangeError);
    await expect(reserve(executionId, { calls: 1.5 })).rejects.toThrow(RangeError);
    await expect(
      reserve(executionId, { calls: 1 }, { limits: { ...LIMITS, maxToolCalls: -1 } }),
    ).rejects.toThrow(RangeError);

    expect(await budgetRowCount(executionId)).toBe(0);
  });
});
