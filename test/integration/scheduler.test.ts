import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimExecution, recoverStaleExecutions, scheduleDueExecutions } from '../../apps/worker/src/scheduling';
import { createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let ownerId: string;
let providerId: string;
let taskId: string;

const schedule = { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 };
const limits = { maxDurationSec: 60, maxAgentSteps: 3, maxPageVisits: 2, maxOutputBytes: 10000, maxToolCalls: 5, maxSearchQueries: 1 };

async function insertTask(nextRunAt: Date, enabled = true): Promise<string> {
  const id = randomUUID();
  await harness.db.pool.query(
    `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification, next_run_at)
     values ($1,$2,'Scheduled task','Research something with sources.',$3,'mock-researcher',$4,$5,'Europe/Vienna',$6,true,'none',$7)`,
    [id, ownerId, providerId, enabled, JSON.stringify(schedule), JSON.stringify(limits), nextRunAt.toISOString()],
  );
  return id;
}

beforeAll(async () => {
  harness = await createHarness();
  const user = await harness.db.pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'Owner','owner@example.com',true,'USER') returning id`, [randomUUID()]);
  ownerId = user.rows[0].id;
  const provider = await harness.db.pool.query(
    `insert into providers (id, name, kind, enabled, is_default, config) values ($1,'Mock','openai-compatible',true,false,$2) returning id`,
    [randomUUID(), JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'mock-researcher', supportsTools: true }] })],
  );
  providerId = provider.rows[0].id;
  taskId = await insertTask(new Date(Date.now() - 60_000));
});

afterAll(async () => {
  await harness.close();
});

describe('scheduler', () => {
  it('books exactly one execution per due occurrence and advances next_run_at', async () => {
    const first = await scheduleDueExecutions(harness.db.db);
    expect(first.length).toBe(1);
    expect(first[0]?.taskId).toBe(taskId);

    const second = await scheduleDueExecutions(harness.db.db);
    expect(second.length).toBe(0);

    const rows = await harness.db.pool.query('select scheduled_for, status from executions where task_id = $1', [taskId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('queued');

    const task = await harness.db.pool.query('select next_run_at from tasks where id = $1', [taskId]);
    expect(new Date(task.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('produces no duplicate when two scheduler ticks run concurrently', async () => {
    const other = await insertTask(new Date(Date.now() - 30_000));
    const [a, b] = await Promise.all([scheduleDueExecutions(harness.db.db), scheduleDueExecutions(harness.db.db)]);
    expect(a.length + b.length).toBe(1);
    const rows = await harness.db.pool.query('select count(*)::int as count from executions where task_id = $1', [other]);
    expect(rows.rows[0].count).toBe(1);
  });

  it('ignores paused tasks', async () => {
    await insertTask(new Date(Date.now() - 30_000), false);
    const created = await scheduleDueExecutions(harness.db.db);
    expect(created).toHaveLength(0);
  });

  it('rejects a second execution for the same occurrence at the database level', async () => {
    const occurrence = new Date('2026-10-01T04:30:00Z');
    const id = await insertTask(new Date(Date.now() - 10_000));
    const insert = `insert into executions (id, task_id, owner_id, task_title, status, trigger, scheduled_for, model, provider_id)
      values ($1,$2,$3,'t','queued','schedule',$4,'mock-researcher',$5)`;
    await harness.db.pool.query(insert, [randomUUID(), id, ownerId, occurrence.toISOString(), providerId]);
    await expect(harness.db.pool.query(insert, [randomUUID(), id, ownerId, occurrence.toISOString(), providerId])).rejects.toThrow(/duplicate key|unique/i);
  });

  it('lets exactly one worker claim an execution', async () => {
    const executionId = randomUUID();
    const id = await insertTask(new Date(Date.now() - 5_000));
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'t','queued','manual','mock-researcher',$4)`,
      [executionId, id, ownerId, providerId],
    );
    const claims = await Promise.all([
      claimExecution(harness.db.db, executionId, 'worker-a', 60),
      claimExecution(harness.db.db, executionId, 'worker-b', 60),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await harness.db.pool.query('select status, worker_id from executions where id = $1', [executionId]);
    expect(row.rows[0].status).toBe('running');
  });

  it('requeues an execution whose worker died and cancels one that was cancelled meanwhile', async () => {
    const stale = randomUUID();
    const cancelled = randomUUID();
    const id = await insertTask(new Date(Date.now() - 5_000));
    const insert = `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id, worker_id, lease_expires_at, cancel_requested)
      values ($1,$2,$3,'t','running','manual','mock-researcher',$4,'dead-worker', now() - interval '1 minute', $5)`;
    await harness.db.pool.query(insert, [stale, id, ownerId, providerId, false]);
    await harness.db.pool.query(insert, [cancelled, id, ownerId, providerId, true]);

    const recovered = await recoverStaleExecutions(harness.db.db);
    expect(recovered.requeued).toContain(stale);
    expect(recovered.cancelled).toContain(cancelled);
    const rows = await harness.db.pool.query('select id, status from executions where id = any($1::uuid[])', [[stale, cancelled]]);
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row.status]));
    expect(byId[stale]).toBe('queued');
    expect(byId[cancelled]).toBe('cancelled');
  });
});
