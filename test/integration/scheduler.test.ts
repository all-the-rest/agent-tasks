import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
type TestSchedule = { preset: string; timezone: string; hour: number; minute: number; runAt?: string; cron?: string };

async function insertTask(
  nextRunAt: Date,
  enabled = true,
  taskOwnerId = ownerId,
  endCondition: { type: 'never' } | { type: 'on_date'; date: string } | { type: 'after_runs'; runs: number } = { type: 'never' },
  taskSchedule: TestSchedule = schedule,
): Promise<string> {
  const id = randomUUID();
  await harness.db.pool.query(
    `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, end_condition, timezone, limits, allow_web_research, notification, next_run_at)
     values ($1,$2,'Scheduled task','Research something with sources.',$3,'mock-researcher',$4,$5,$6,'Europe/Vienna',$7,true,'none',$8)`,
    [id, taskOwnerId, providerId, enabled, JSON.stringify(taskSchedule), JSON.stringify(endCondition), JSON.stringify(limits), nextRunAt.toISOString()],
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

  it('enforces an after-runs limit exactly once across concurrent scheduler ticks', async () => {
    const now = new Date('2026-11-03T06:00:00.000Z');
    const id = await insertTask(new Date('2026-11-03T05:30:00.000Z'), true, ownerId, { type: 'after_runs', runs: 1 });
    const [first, second] = await Promise.all([
      scheduleDueExecutions(harness.db.db, now),
      scheduleDueExecutions(harness.db.db, now),
    ]);

    expect([...first, ...second].filter((run) => run.taskId === id)).toHaveLength(1);
    const task = await harness.db.pool.query<{ enabled: boolean; next_run_at: Date | null; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, next_run_at, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(task.rows[0]).toMatchObject({ enabled: false, next_run_at: null, scheduled_run_count: 1 });
    expect(task.rows[0]?.completed_at).toBeInstanceOf(Date);
    const executions = await harness.db.pool.query<{ count: number }>(
      "select count(*)::int as count from executions where task_id = $1 and trigger = 'schedule'",
      [id],
    );
    expect(executions.rows[0]?.count).toBe(1);
  });

  it('ignores paused tasks', async () => {
    await insertTask(new Date(Date.now() - 30_000), false);
    const created = await scheduleDueExecutions(harness.db.db);
    expect(created).toHaveLength(0);
  });

  it('counts only scheduled bookings and completes at the configured run cap', async () => {
    const now = new Date('2026-11-03T06:00:00.000Z');
    const id = await insertTask(new Date('2026-11-02T05:30:00.000Z'), true, ownerId, { type: 'after_runs', runs: 2 });
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id)
       values ($1,$2,$3,'manual','completed','manual','mock-researcher',$4),
              ($5,$2,$3,'retry','completed','retry','mock-researcher',$4)`,
      [randomUUID(), id, ownerId, providerId, randomUUID()],
    );

    const first = await scheduleDueExecutions(harness.db.db, now);
    expect(first.filter((run) => run.taskId === id)).toHaveLength(1);
    const afterFirst = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(afterFirst.rows[0]).toMatchObject({ enabled: true, scheduled_run_count: 1, completed_at: null });

    const second = await scheduleDueExecutions(harness.db.db, now);
    expect(second.filter((run) => run.taskId === id)).toHaveLength(1);
    const afterSecond = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(afterSecond.rows[0]?.enabled).toBe(false);
    expect(afterSecond.rows[0]?.scheduled_run_count).toBe(2);
    expect(afterSecond.rows[0]?.completed_at).toBeInstanceOf(Date);
    expect(await scheduleDueExecutions(harness.db.db, now)).toHaveLength(0);
    const executions = await harness.db.pool.query<{ trigger: string }>('select trigger from executions where task_id = $1', [id]);
    expect(executions.rows.map((row) => row.trigger).sort()).toEqual(['manual', 'retry', 'schedule', 'schedule']);
  });

  it('completes a one-off schedule after its only occurrence when the run cap cannot be reached', async () => {
    const occurrence = new Date('2026-11-03T05:30:00.000Z');
    const now = new Date('2026-11-03T06:00:00.000Z');
    const id = await insertTask(occurrence, true, ownerId, { type: 'after_runs', runs: 3 }, {
      preset: 'once',
      timezone: 'Europe/Vienna',
      hour: 6,
      minute: 30,
      runAt: occurrence.toISOString(),
    });

    const created = await scheduleDueExecutions(harness.db.db, now);
    expect(created.filter((run) => run.taskId === id)).toHaveLength(1);
    const task = await harness.db.pool.query<{ enabled: boolean; next_run_at: Date | null; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, next_run_at, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(task.rows[0]).toMatchObject({ enabled: false, next_run_at: null, scheduled_run_count: 1 });
    expect(task.rows[0]?.completed_at).toBeInstanceOf(Date);
  });

  it('includes occurrences on the selected local end date, then completes without booking later dates', async () => {
    const id = await insertTask(
      new Date('2026-11-03T05:30:00.000Z'),
      true,
      ownerId,
      { type: 'on_date', date: '2026-11-03' },
    );
    const onEndDate = await scheduleDueExecutions(harness.db.db, new Date('2026-11-03T06:00:00.000Z'));
    expect(onEndDate.filter((run) => run.taskId === id)).toHaveLength(1);
    const afterBooking = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(afterBooking.rows[0]).toMatchObject({ enabled: true, scheduled_run_count: 1, completed_at: null });

    const afterEndDate = await scheduleDueExecutions(harness.db.db, new Date('2026-11-04T00:30:00.000Z'));
    expect(afterEndDate.filter((run) => run.taskId === id)).toHaveLength(0);
    const completed = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(completed.rows[0]?.enabled).toBe(false);
    expect(completed.rows[0]?.scheduled_run_count).toBe(1);
    expect(completed.rows[0]?.completed_at).toBeInstanceOf(Date);
    const executions = await harness.db.pool.query('select id from executions where task_id = $1', [id]);
    expect(executions.rows).toHaveLength(1);
  });

  it.each([
    {
      name: 'daily',
      taskSchedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
    },
    {
      name: 'custom cron',
      taskSchedule: { preset: 'custom', timezone: 'Europe/Vienna', hour: 6, minute: 30, cron: '30 6 * * *' },
    },
  ])('catches up every overdue $name occurrence within the inclusive local end date', async ({ taskSchedule }) => {
    const occurrences = [new Date('2026-11-02T05:30:00.000Z'), new Date('2026-11-03T05:30:00.000Z')];
    // 00:30 UTC on Nov 4 is 01:30 in Vienna; both prior local occurrences are inside Nov 3's inclusive window.
    const now = new Date('2026-11-04T00:30:00.000Z');
    const id = await insertTask(occurrences[0] as Date, true, ownerId, { type: 'on_date', date: '2026-11-03' }, taskSchedule);

    const first = await scheduleDueExecutions(harness.db.db, now);
    expect(first.filter((run) => run.taskId === id).map((run) => run.occurrence)).toEqual([occurrences[0]]);
    const afterFirst = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null; next_run_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at, next_run_at from tasks where id = $1',
      [id],
    );
    expect(afterFirst.rows[0]).toMatchObject({ enabled: true, scheduled_run_count: 1, completed_at: null, next_run_at: occurrences[1] });

    const second = await scheduleDueExecutions(harness.db.db, now);
    expect(second.filter((run) => run.taskId === id).map((run) => run.occurrence)).toEqual([occurrences[1]]);
    const completed = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null; next_run_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at, next_run_at from tasks where id = $1',
      [id],
    );
    expect(completed.rows[0]).toMatchObject({ enabled: false, scheduled_run_count: 2, next_run_at: null });
    expect(completed.rows[0]?.completed_at).toBeInstanceOf(Date);
    const executions = await harness.db.pool.query<{ scheduled_for: Date }>(
      "select scheduled_for from executions where task_id = $1 and trigger = 'schedule' order by scheduled_for",
      [id],
    );
    expect(executions.rows.map((row) => row.scheduled_for)).toEqual(occurrences);
  });

  it('catches up overdue date-bounded occurrences without duplicates across concurrent scheduler ticks', async () => {
    const occurrences = [new Date('2026-11-02T05:30:00.000Z'), new Date('2026-11-03T05:30:00.000Z')];
    const now = new Date('2026-11-04T00:30:00.000Z');
    const id = await insertTask(occurrences[0] as Date, true, ownerId, { type: 'on_date', date: '2026-11-03' });
    const booked: Date[] = [];

    for (let round = 0; round < 3; round += 1) {
      const [first, second] = await Promise.all([
        scheduleDueExecutions(harness.db.db, now),
        scheduleDueExecutions(harness.db.db, now),
      ]);
      booked.push(...[...first, ...second].filter((run) => run.taskId === id).map((run) => run.occurrence));
    }

    expect(booked.sort((left, right) => left.getTime() - right.getTime())).toEqual(occurrences);
    const task = await harness.db.pool.query<{ enabled: boolean; scheduled_run_count: number; completed_at: Date | null; next_run_at: Date | null }>(
      'select enabled, scheduled_run_count, completed_at, next_run_at from tasks where id = $1',
      [id],
    );
    expect(task.rows[0]).toMatchObject({ enabled: false, scheduled_run_count: 2, next_run_at: null });
    expect(task.rows[0]?.completed_at).toBeInstanceOf(Date);
    const executions = await harness.db.pool.query<{ scheduled_for: Date }>(
      "select scheduled_for from executions where task_id = $1 and trigger = 'schedule' order by scheduled_for",
      [id],
    );
    expect(executions.rows.map((row) => row.scheduled_for)).toEqual(occurrences);
  });

  it('completes a paused task after its local end date without booking its overdue occurrence', async () => {
    const id = await insertTask(
      new Date('2026-11-03T05:30:00.000Z'),
      false,
      ownerId,
      { type: 'on_date', date: '2026-11-03' },
    );
    // 23:30 UTC is already Nov 4 in Europe/Vienna, so the Nov 3 local end date has passed.
    const created = await scheduleDueExecutions(harness.db.db, new Date('2026-11-03T23:30:00.000Z'));
    expect(created.filter((run) => run.taskId === id)).toHaveLength(0);

    const task = await harness.db.pool.query<{ enabled: boolean; next_run_at: Date | null; scheduled_run_count: number; completed_at: Date | null }>(
      'select enabled, next_run_at, scheduled_run_count, completed_at from tasks where id = $1',
      [id],
    );
    expect(task.rows[0]).toMatchObject({ enabled: false, next_run_at: null, scheduled_run_count: 0 });
    expect(task.rows[0]?.completed_at).toBeInstanceOf(Date);
    const executions = await harness.db.pool.query<{ count: number }>(
      'select count(*)::int as count from executions where task_id = $1',
      [id],
    );
    expect(executions.rows[0]?.count).toBe(0);
  });

  it('backfills scheduled counts and precisely completes exhausted one-off tasks in the migration', async () => {
    const client = await harness.db.pool.connect();
    const schemaName = `end_condition_migration_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('begin');
      await client.query(`create schema "${schemaName}"`);
      await client.query(`set local search_path to "${schemaName}"`);
      await client.query(`create table tasks (
        id uuid primary key,
        owner_id text not null,
        schedule jsonb not null,
        enabled boolean not null,
        next_run_at timestamptz
      )`);
      await client.query(`create table executions (
        task_id uuid not null,
        owner_id text not null,
        trigger text not null,
        scheduled_for timestamptz,
        created_at timestamptz not null
      )`);

      const taskWithHistory = randomUUID();
      const taskWithoutScheduledHistory = randomUUID();
      const exhaustedOnce = randomUUID();
      const futureOnce = randomUUID();
      const pausedOnce = randomUUID();
      const wrongOwnerOnce = randomUUID();
      const exhaustedRunAt = new Date(Date.now() - 60_000);
      const futureRunAt = new Date(Date.now() + 60 * 60_000);
      const bookedAt = new Date();
      const dailySchedule = { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 };
      const onceSchedule = (runAt: Date) => ({
        preset: 'once',
        timezone: 'Europe/Vienna',
        hour: 6,
        minute: 30,
        runAt: runAt.toISOString(),
      });
      const insertFixtureTask = (id: string, owner: string, fixtureSchedule: object, enabled: boolean, nextRunAt: Date | null) =>
        client.query(
          'insert into tasks (id, owner_id, schedule, enabled, next_run_at) values ($1, $2, $3, $4, $5)',
          [id, owner, JSON.stringify(fixtureSchedule), enabled, nextRunAt?.toISOString() ?? null],
        );
      await insertFixtureTask(taskWithHistory, 'owner-a', dailySchedule, true, null);
      await insertFixtureTask(taskWithoutScheduledHistory, 'owner-b', dailySchedule, true, null);
      await insertFixtureTask(exhaustedOnce, 'owner-a', onceSchedule(exhaustedRunAt), true, null);
      await insertFixtureTask(futureOnce, 'owner-a', onceSchedule(futureRunAt), true, futureRunAt);
      await insertFixtureTask(pausedOnce, 'owner-a', onceSchedule(exhaustedRunAt), false, null);
      await insertFixtureTask(wrongOwnerOnce, 'owner-b', onceSchedule(exhaustedRunAt), true, null);
      await client.query(
        `insert into executions (task_id, owner_id, trigger, scheduled_for, created_at)
         values ($1, 'owner-a', 'schedule', null, $7), ($1, 'owner-a', 'schedule', null, $7),
                ($1, 'owner-a', 'manual', null, $7), ($1, 'owner-a', 'retry', null, $7),
                ($1, 'owner-b', 'schedule', null, $7),
                ($2, 'owner-b', 'manual', null, $7), ($2, 'owner-b', 'retry', null, $7),
                ($3, 'owner-a', 'schedule', $4, $5),
                ($6, 'owner-a', 'schedule', $4, $5)`,
        [taskWithHistory, taskWithoutScheduledHistory, exhaustedOnce, exhaustedRunAt.toISOString(), bookedAt.toISOString(), wrongOwnerOnce, bookedAt.toISOString()],
      );

      const migration = await readFile(new URL('../../packages/database/drizzle/0005_deep_madripoor.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
        await client.query(statement);
      }

      const rows = await client.query<{
        id: string;
        scheduled_run_count: number;
        end_condition: { type: string };
        enabled: boolean;
        completed_at: Date | null;
      }>(
        'select id, scheduled_run_count, end_condition, enabled, completed_at from tasks order by id',
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(byId.get(taskWithHistory)).toMatchObject({ scheduled_run_count: 2, enabled: true, completed_at: null, end_condition: { type: 'never' } });
      expect(byId.get(taskWithoutScheduledHistory)).toMatchObject({ scheduled_run_count: 0, enabled: true, completed_at: null, end_condition: { type: 'never' } });
      expect(byId.get(exhaustedOnce)).toMatchObject({ scheduled_run_count: 1, enabled: false, end_condition: { type: 'never' } });
      expect(byId.get(exhaustedOnce)?.completed_at?.toISOString()).toBe(bookedAt.toISOString());
      expect(byId.get(futureOnce)).toMatchObject({ scheduled_run_count: 0, enabled: true, completed_at: null });
      expect(byId.get(pausedOnce)).toMatchObject({ scheduled_run_count: 0, enabled: false, completed_at: null });
      expect(byId.get(wrongOwnerOnce)).toMatchObject({ scheduled_run_count: 0, enabled: true, completed_at: null });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('rejects a second execution for the same occurrence at the database level', async () => {
    const occurrence = new Date('2026-10-01T04:30:00Z');
    const id = await insertTask(new Date(Date.now() - 10_000));
    const insert = `insert into executions (id, task_id, owner_id, task_title, status, trigger, scheduled_for, model, provider_id)
      values ($1,$2,$3,'t','queued','schedule',$4,'mock-researcher',$5)`;
    await harness.db.pool.query(insert, [randomUUID(), id, ownerId, occurrence.toISOString(), providerId]);
    await expect(harness.db.pool.query(insert, [randomUUID(), id, ownerId, occurrence.toISOString(), providerId])).rejects.toThrow(/duplicate key|unique/i);
  });

  it('lets exactly one worker claim the same execution', async () => {
    const executionId = randomUUID();
    const id = await insertTask(new Date(Date.now() - 5_000));
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'t','queued','manual','mock-researcher',$4)`,
      [executionId, id, ownerId, providerId],
    );
    const executionLimits = { maxTaskExecutionsPerDay: 100, maxConcurrentExecutionsPerUser: 1 };
    const claims = await Promise.all([
      claimExecution(harness.db.db, executionId, 'worker-a', 60, executionLimits, 3),
      claimExecution(harness.db.db, executionId, 'worker-b', 60, executionLimits, 3),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(['claimed', 'not_claimed']);
    const row = await harness.db.pool.query('select status, worker_id from executions where id = $1', [executionId]);
    expect(row.rows[0].status).toBe('running');
    await harness.db.pool.query("update executions set status = 'completed', finished_at = now() where id = $1", [executionId]);
  });

  it('reserves one per-user execution slot across concurrent workers', async () => {
    const id = await insertTask(new Date(Date.now() - 5_000));
    const executionIds = [randomUUID(), randomUUID()];
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id)
       values ($1,$3,$4,'first','queued','manual','mock-researcher',$5),
              ($2,$3,$4,'second','queued','manual','mock-researcher',$5)`,
      [...executionIds, id, ownerId, providerId],
    );
    const executionLimits = { maxTaskExecutionsPerDay: 100, maxConcurrentExecutionsPerUser: 1 };
    const claims = await Promise.all(
      executionIds.map((executionId, index) =>
        claimExecution(harness.db.db, executionId, `worker-${index}`, 60, executionLimits, 3),
      ),
    );

    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'refused' && claim.reason === 'concurrency' && claim.retryAttempt === 2)).toHaveLength(1);
    const rows = await harness.db.pool.query(
      'select status, attempt from executions where id = any($1::uuid[])',
      [executionIds],
    );
    expect(rows.rows.map((row) => row.status).sort()).toEqual(['queued', 'running']);
    expect(rows.rows.find((row) => row.status === 'queued')?.attempt).toBe(2);
    await harness.db.pool.query("update executions set status = 'completed', finished_at = now() where id = any($1::uuid[])", [executionIds]);
  });

  it('admits only the daily quota across concurrent workers', async () => {
    const user = await harness.db.pool.query(
      `insert into "user" (id, name, email, email_verified, role) values ($1,'Quota Owner',$2,true,'USER') returning id`,
      [randomUUID(), `quota-${randomUUID()}@example.com`],
    );
    const quotaOwnerId = user.rows[0].id as string;
    const id = await insertTask(new Date(Date.now() - 5_000), true, quotaOwnerId);
    const executionIds = [randomUUID(), randomUUID()];
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id)
       values ($1,$3,$4,'first','queued','manual','mock-researcher',$5),
              ($2,$3,$4,'second','queued','manual','mock-researcher',$5)`,
      [...executionIds, id, quotaOwnerId, providerId],
    );
    const executionLimits = { maxTaskExecutionsPerDay: 1, maxConcurrentExecutionsPerUser: 10 };
    const claims = await Promise.all(
      executionIds.map((executionId, index) =>
        claimExecution(harness.db.db, executionId, `worker-${index}`, 60, executionLimits, 3),
      ),
    );

    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'refused' && claim.reason === 'quota' && claim.retryAttempt === 2)).toHaveLength(1);
    const rows = await harness.db.pool.query(
      'select status, attempt from executions where id = any($1::uuid[])',
      [executionIds],
    );
    expect(rows.rows.map((row) => row.status).sort()).toEqual(['queued', 'running']);
    expect(rows.rows.find((row) => row.status === 'queued')?.attempt).toBe(2);
    await harness.db.pool.query("update executions set status = 'completed', finished_at = now() where id = any($1::uuid[])", [executionIds]);
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
