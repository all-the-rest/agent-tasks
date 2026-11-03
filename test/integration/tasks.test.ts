import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tasks as taskRows } from '@agent-tasks/database';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { scheduleDueExecutions } from '../../apps/worker/src/scheduling';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function providerFor(current: TestHarness, adminCookie: string): Promise<string> {
  const provider = await current.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: {
      name: 'Partial PATCH provider',
      kind: 'openai-compatible',
      config: { baseUrl: 'http://mock:8080/v1', models: [{ id: 'mock-researcher', supportsTools: true }] },
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const providerId = provider.json().id as string;
  const credential = await current.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${providerId}/credentials`,
    headers: { cookie: adminCookie },
    payload: { apiKey: 'partial-patch-key-123' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  return providerId;
}

const taskBody = (providerId: string) => ({
  title: 'Paused research task',
  prompt: 'Research the current state of public transport in Vienna and cite sources.',
  providerId,
  model: 'mock-researcher',
  enabled: true,
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  allowWebResearch: false,
  notification: 'none',
});

async function createTask(current: TestHarness, cookie: string, providerId: string, title: string): Promise<string> {
  const response = await current.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie },
    payload: { ...taskBody(providerId), title },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

async function insertExecution(
  current: TestHarness,
  taskId: string,
  ownerId: string,
  status: 'completed' | 'queued' = 'completed',
  readAt: Date | null = null,
): Promise<string> {
  const id = randomUUID();
  await current.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, "trigger", read_at)
     values ($1, $2, $3, 'Inbox test execution', $4, 'manual', $5)`,
    [id, taskId, ownerId, status, readAt],
  );
  return id;
}

describe('partial task updates', () => {
  it('does not resume a paused task or reset its flags on a title-only PATCH', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'alice@example.com');
    const providerId = await providerFor(harness, admin.cookie);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: taskBody(providerId),
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;

    const paused = await harness.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/pause`, headers: { cookie: alice.cookie } });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().enabled).toBe(false);

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { title: 'Renamed while paused' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      title: 'Renamed while paused',
      enabled: false,
      allowWebResearch: false,
      notification: 'none',
      nextRunAt: null,
    });

    const stored = await harness.db.pool.query<{ enabled: boolean; allow_web_research: boolean; notification: string; next_run_at: Date | null }>(
      'select enabled, allow_web_research, notification, next_run_at from tasks where id = $1',
      [taskId],
    );
    expect(stored.rows[0]).toMatchObject({ enabled: false, allow_web_research: false, notification: 'none', next_run_at: null });
  });

  it('does not expose configurable agent limits and ignores per-task overrides', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'alice@example.com');
    const providerId = await providerFor(harness, admin.cookie);
    const settings = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { agentLimits: { maxDurationSec: 900, maxAgentSteps: 45 } },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json()).not.toHaveProperty('agentLimits');

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: {
        ...taskBody(providerId),
        limits: { maxDurationSec: 30, maxAgentSteps: 1, maxPageVisits: 0, maxOutputBytes: 1_000, maxToolCalls: 1, maxSearchQueries: 0 },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).not.toHaveProperty('limits');
    expect(created.json()).not.toHaveProperty('agentLimits');
    const taskId = created.json().id as string;

    const stored = await harness.db.pool.query<{ limits: typeof AGENT_RUNTIME_LIMITS }>('select limits from tasks where id = $1', [taskId]);
    expect(stored.rows[0]?.limits).toEqual(AGENT_RUNTIME_LIMITS);

    const listed = await harness.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: alice.cookie } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().find((task: { id: string }) => task.id === taskId)).not.toHaveProperty('limits');

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).not.toHaveProperty('limits');

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { limits: { maxDurationSec: 30, maxAgentSteps: 1 } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).not.toHaveProperty('limits');

    const paused = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/pause`,
      headers: { cookie: alice.cookie },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).not.toHaveProperty('limits');

    const resumed = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/resume`,
      headers: { cookie: alice.cookie },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).not.toHaveProperty('limits');

    const copy = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/duplicate`,
      headers: { cookie: alice.cookie },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json()).not.toHaveProperty('limits');

    const duplicateId = copy.json().id as string;
    const duplicateSnapshot = await harness.db.pool.query<{ limits: typeof AGENT_RUNTIME_LIMITS }>(
      'select limits from tasks where id = $1',
      [duplicateId],
    );
    expect(duplicateSnapshot.rows[0]?.limits).toEqual(AGENT_RUNTIME_LIMITS);

    const originalSnapshot = await harness.db.pool.query<{ limits: typeof AGENT_RUNTIME_LIMITS }>(
      'select limits from tasks where id = $1',
      [taskId],
    );
    expect(originalSnapshot.rows[0]?.limits).toEqual(AGENT_RUNTIME_LIMITS);
  });

  it('keeps timezone and locale when only the theme is patched', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: { cookie: admin.cookie },
      payload: { timezone: 'America/New_York', locale: 'de' },
    });
    expect(first.statusCode, first.body).toBe(204);

    const theme = await harness.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: { cookie: admin.cookie },
      payload: { theme: 'dark' },
    });
    expect(theme.statusCode, theme.body).toBe(204);

    const me = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin.cookie } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().preferences).toMatchObject({ timezone: 'America/New_York', locale: 'de', theme: 'dark' });
  });
});

describe('task end conditions', () => {
  it('validates and persists end conditions without changing manual-run scheduling semantics', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'end-condition@example.com');
    const providerId = await providerFor(harness, admin.cookie);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: { ...taskBody(providerId), endCondition: { type: 'after_runs', runs: 1 } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;
    expect(created.json()).toMatchObject({
      endCondition: { type: 'after_runs', runs: 1 },
      scheduledRunCount: 0,
      completedAt: null,
      enabled: true,
    });
    const nextRunAt = created.json().nextRunAt as string;

    const manual = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/run`,
      headers: { cookie: alice.cookie },
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const afterManual = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
    });
    expect(afterManual.json()).toMatchObject({
      enabled: true,
      nextRunAt,
      scheduledRunCount: 0,
      completedAt: null,
    });
    const manualExecution = await harness.db.pool.query<{ trigger: string }>(
      'select trigger from executions where id = $1 and task_id = $2',
      [manual.json().executionId, taskId],
    );
    expect(manualExecution.rows[0]?.trigger).toBe('manual');

    const invalidUpdate = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { endCondition: { type: 'on_date', date: '2026-02-30' } },
    });
    expect(invalidUpdate.statusCode).toBe(400);

    const validUpdate = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { endCondition: { type: 'on_date', date: '2099-12-31' } },
    });
    expect(validUpdate.statusCode, validUpdate.body).toBe(200);
    expect(validUpdate.json().endCondition).toEqual({ type: 'on_date', date: '2099-12-31' });

    const bob = await inviteAndAccept(harness, admin.cookie, 'another-end-condition@example.com');
    const otherOwner = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: bob.cookie },
      payload: { endCondition: { type: 'never' } },
    });
    expect(otherOwner.statusCode).toBe(404);
  });

  it('preserves an eligible overdue occurrence during a title PATCH so the scheduler can catch it up', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'date-catch-up@example.com');
    const providerId = await providerFor(harness, admin.cookie);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: taskBody(providerId),
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const endDate = yesterday.toISOString().slice(0, 10);
    const occurrence = new Date(`${endDate}T06:30:00.000Z`);
    const expiredSchedule = { preset: 'daily', timezone: 'UTC', hour: 6, minute: 30 };
    await harness.db.pool.query(
      `update tasks
       set schedule = $2::jsonb, timezone = 'UTC',
           end_condition = $3::jsonb, next_run_at = $4
       where id = $1`,
      [taskId, JSON.stringify(expiredSchedule), JSON.stringify({ type: 'on_date', date: endDate }), occurrence.toISOString()],
    );

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { title: 'Keep the pending date-bounded run' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      title: 'Keep the pending date-bounded run',
      enabled: true,
      endCondition: { type: 'on_date', date: endDate },
      nextRunAt: occurrence.toISOString(),
      completedAt: null,
      scheduledRunCount: 0,
    });

    const booked = await scheduleDueExecutions(harness.db.db, new Date());
    expect(booked.filter((run) => run.taskId === taskId).map((run) => run.occurrence)).toEqual([occurrence]);
    const afterCatchUp = await harness.db.pool.query<{
      enabled: boolean;
      next_run_at: Date | null;
      completed_at: Date | null;
      scheduled_run_count: number;
    }>(
      'select enabled, next_run_at, completed_at, scheduled_run_count from tasks where id = $1',
      [taskId],
    );
    expect(afterCatchUp.rows[0]).toMatchObject({ enabled: false, next_run_at: null, scheduled_run_count: 1 });
    expect(afterCatchUp.rows[0]?.completed_at).toBeInstanceOf(Date);
  });

  it('completes a paused task with an expired date condition during a title PATCH', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'paused-date-expiry@example.com');
    const providerId = await providerFor(harness, admin.cookie);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: taskBody(providerId),
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const endDate = yesterday.toISOString().slice(0, 10);
    await harness.db.pool.query(
      `update tasks
       set enabled = false, next_run_at = null, timezone = 'UTC',
           schedule = $2::jsonb, end_condition = $3::jsonb
       where id = $1`,
      [
        taskId,
        JSON.stringify({ preset: 'daily', timezone: 'UTC', hour: 6, minute: 30 }),
        JSON.stringify({ type: 'on_date', date: endDate }),
      ],
    );

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { title: 'Paused expired task' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false, nextRunAt: null, completedAt: expect.any(String) });
  });

  it('preserves exhausted one-off completion on unchanged edits and resume, but allows a future reschedule', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'once-reschedule@example.com');
    const providerId = await providerFor(harness, admin.cookie);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: { ...taskBody(providerId), endCondition: { type: 'after_runs', runs: 3 } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;
    const pastRunAt = new Date(Date.now() - 60_000).toISOString();
    const onceSchedule = {
      preset: 'once',
      timezone: 'Europe/Vienna',
      hour: 6,
      minute: 30,
      runAt: pastRunAt,
    };
    const completedAt = new Date(Date.now() - 30_000);
    await harness.db.pool.query(
      `update tasks
       set schedule = $2::jsonb, enabled = false, next_run_at = null,
           scheduled_run_count = 1, completed_at = $3
       where id = $1`,
      [taskId, JSON.stringify(onceSchedule), completedAt.toISOString()],
    );

    const unchangedEdit = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { enabled: false, schedule: onceSchedule, endCondition: { type: 'after_runs', runs: 3 } },
    });
    expect(unchangedEdit.statusCode, unchangedEdit.body).toBe(200);
    expect(unchangedEdit.json()).toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduledRunCount: 1,
      completedAt: completedAt.toISOString(),
    });

    const resumed = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/resume`,
      headers: { cookie: alice.cookie },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduledRunCount: 1,
      completedAt: completedAt.toISOString(),
    });

    const futureRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const futureSchedule = { ...onceSchedule, runAt: futureRunAt };
    const rescheduled = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { enabled: true, schedule: futureSchedule },
    });
    expect(rescheduled.statusCode, rescheduled.body).toBe(200);
    expect(rescheduled.json()).toMatchObject({
      enabled: true,
      nextRunAt: futureRunAt,
      scheduledRunCount: 1,
      completedAt: null,
    });
  });
});

describe('scheduled-task inbox', () => {
  it('filters task states and keeps unread counts and read markers owner-scoped', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'inbox-alice@example.com');
    const bob = await inviteAndAccept(harness, admin.cookie, 'inbox-bob@example.com');
    const providerId = await providerFor(harness, admin.cookie);

    const aliceActiveId = await createTask(harness, alice.cookie, providerId, 'Alice active task');
    const alicePausedId = await createTask(harness, alice.cookie, providerId, 'Alice paused task');
    const aliceCompletedId = await createTask(harness, alice.cookie, providerId, 'Alice completed task');
    const bobTaskId = await createTask(harness, bob.cookie, providerId, 'Bob active task');
    const adminTaskId = await createTask(harness, admin.cookie, providerId, 'Admin active task');

    const paused = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${alicePausedId}/pause`,
      headers: { cookie: alice.cookie },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    await harness.db.pool.query('update tasks set enabled = false, next_run_at = null, completed_at = now() where id = $1', [
      aliceCompletedId,
    ]);

    await insertExecution(harness, aliceActiveId, alice.id);
    await insertExecution(harness, alicePausedId, alice.id);
    const aliceCompletedExecutionId = await insertExecution(harness, aliceCompletedId, alice.id);
    const aliceCompletedSiblingId = await insertExecution(harness, aliceCompletedId, alice.id);
    await insertExecution(harness, aliceCompletedId, alice.id, 'completed', new Date());
    await insertExecution(harness, bobTaskId, bob.id);
    await insertExecution(harness, adminTaskId, admin.id);
    const queuedExecutionId = await insertExecution(harness, aliceActiveId, alice.id, 'queued');

    const listFor = async (cookie: string, status?: string) =>
      harness?.app.inject({
        method: 'GET',
        url: `/api/tasks${status ? `?status=${status}` : ''}`,
        headers: { cookie },
      });

    const active = await listFor(alice.cookie, 'active');
    expect(active?.statusCode, active?.body).toBe(200);
    expect(active?.json().map((task: { id: string }) => task.id)).toEqual([aliceActiveId]);
    expect(active?.json()[0]).toMatchObject({ status: 'active', unreadCount: 1 });

    const pausedTasks = await listFor(alice.cookie, 'paused');
    expect(pausedTasks?.statusCode, pausedTasks?.body).toBe(200);
    expect(pausedTasks?.json()).toEqual([expect.objectContaining({ id: alicePausedId, status: 'paused', unreadCount: 1 })]);

    const completed = await listFor(alice.cookie, 'completed');
    expect(completed?.statusCode, completed?.body).toBe(200);
    expect(completed?.json()).toEqual([expect.objectContaining({ id: aliceCompletedId, status: 'completed', unreadCount: 2 })]);

    const allAliceTasks = await listFor(alice.cookie);
    expect(allAliceTasks?.json().map((task: { id: string }) => task.id)).toHaveLength(3);
    const invalidStatus = await listFor(alice.cookie, 'archived');
    expect(invalidStatus?.statusCode).toBe(400);

    const bobTasks = await listFor(bob.cookie, 'active');
    expect(bobTasks?.json()).toEqual([expect.objectContaining({ id: bobTaskId, unreadCount: 1 })]);
    const adminTasks = await listFor(admin.cookie, 'active');
    expect(adminTasks?.json()).toEqual([expect.objectContaining({ id: adminTaskId, unreadCount: 1 })]);

    const executionBeforeRead = await harness.app.inject({
      method: 'GET',
      url: `/api/executions/${aliceCompletedExecutionId}`,
      headers: { cookie: alice.cookie },
    });
    expect(executionBeforeRead.statusCode, executionBeforeRead.body).toBe(200);
    expect(executionBeforeRead.json().readAt).toBeNull();
    const taskHistory = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${aliceCompletedId}/executions`,
      headers: { cookie: alice.cookie },
    });
    expect(taskHistory.statusCode, taskHistory.body).toBe(200);
    expect(taskHistory.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: aliceCompletedExecutionId, readAt: null }),
        expect.objectContaining({ id: aliceCompletedSiblingId, readAt: null }),
      ]),
    );

    for (const cookie of [bob.cookie, admin.cookie]) {
      const forbiddenRead = await harness.app.inject({
        method: 'POST',
        url: `/api/executions/${aliceCompletedExecutionId}/read`,
        headers: { cookie },
      });
      expect(forbiddenRead.statusCode).toBe(404);
    }

    const queuedRead = await harness.app.inject({
      method: 'POST',
      url: `/api/executions/${queuedExecutionId}/read`,
      headers: { cookie: alice.cookie },
    });
    expect(queuedRead.statusCode).toBe(409);

    const markedRead = await harness.app.inject({
      method: 'POST',
      url: `/api/executions/${aliceCompletedExecutionId}/read`,
      headers: { cookie: alice.cookie },
    });
    expect(markedRead.statusCode, markedRead.body).toBe(200);
    const readAt = markedRead.json().readAt as string;
    expect(readAt).toEqual(expect.any(String));

    const markedReadAgain = await harness.app.inject({
      method: 'POST',
      url: `/api/executions/${aliceCompletedExecutionId}/read`,
      headers: { cookie: alice.cookie },
    });
    expect(markedReadAgain.statusCode, markedReadAgain.body).toBe(200);
    expect(markedReadAgain.json().readAt).toBe(readAt);

    const executionAfterRead = await harness.app.inject({
      method: 'GET',
      url: `/api/executions/${aliceCompletedExecutionId}`,
      headers: { cookie: alice.cookie },
    });
    expect(executionAfterRead.json().readAt).toBe(readAt);
    const completedAfterRead = await listFor(alice.cookie, 'completed');
    expect(completedAfterRead?.json()[0]).toMatchObject({ id: aliceCompletedId, unreadCount: 1 });
  });
});

describe('cursor pagination', () => {
  it('paginates task lists across timestamp ties without shifting under concurrent inserts', async () => {
    const current = await createHarness();
    harness = current;
    const admin = await bootstrapAdmin(current);
    const alice = await inviteAndAccept(current, admin.cookie, 'pagination-alice@example.com');
    const bob = await inviteAndAccept(current, admin.cookie, 'pagination-bob@example.com');
    const providerId = await providerFor(current, admin.cookie);
    const sourceTaskId = await createTask(current, alice.cookie, providerId, 'Tied source task');
    const tiedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    await current.db.pool.query('update tasks set created_at = $2, updated_at = $2 where id = $1', [sourceTaskId, tiedCreatedAt]);
    const sourceRows = await current.db.db.select().from(taskRows).where(eq(taskRows.id, sourceTaskId)).limit(1);
    const source = sourceRows[0];
    if (!source) throw new Error('pagination source task was not created');

    const tiedTaskIds = Array.from({ length: 54 }, () => randomUUID());
    await current.db.db.insert(taskRows).values(
      tiedTaskIds.map((id, index) => ({
        ...source,
        id,
        title: `Tied task ${index}`,
        createdAt: tiedCreatedAt,
        updatedAt: tiedCreatedAt,
      })),
    );
    const originalIds = [sourceTaskId, ...tiedTaskIds];

    const legacy = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?status=active',
      headers: { cookie: alice.cookie },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(Array.isArray(legacy.json())).toBe(true);
    expect(legacy.json()).toHaveLength(50);

    const firstResponse = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?pagination=cursor&status=active&limit=50',
      headers: { cookie: alice.cookie },
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const firstPage = firstResponse.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const expectedOrder = [...originalIds].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
    expect(firstPage.items.map((task) => task.id)).toEqual(expectedOrder.slice(0, 50));

    const concurrentTaskId = await createTask(current, alice.cookie, providerId, 'Inserted between pages');
    const secondResponse = await current.app.inject({
      method: 'GET',
      url: `/api/tasks?pagination=cursor&status=active&limit=50&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      headers: { cookie: alice.cookie },
    });
    expect(secondResponse.statusCode, secondResponse.body).toBe(200);
    const secondPage = secondResponse.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(secondPage.items.map((task) => task.id)).toEqual(expectedOrder.slice(50));
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.items.map((task) => task.id)).not.toContain(concurrentTaskId);
    expect(new Set([...firstPage.items, ...secondPage.items].map((task) => task.id))).toEqual(new Set(originalIds));

    const refreshedFirstPage = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?pagination=cursor&status=active&limit=50',
      headers: { cookie: alice.cookie },
    });
    expect(refreshedFirstPage.json().items[0].id).toBe(concurrentTaskId);
    const bobTaskId = await createTask(current, bob.cookie, providerId, 'Bob page-owned task');
    const bobPage = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?pagination=cursor&status=active',
      headers: { cookie: bob.cookie },
    });
    expect(bobPage.json().items.map((task: { id: string }) => task.id)).toEqual([bobTaskId]);
  }, 20_000);

  it('paginates task history beyond 20 runs with exact timestamp-tie cursors', async () => {
    const current = await createHarness();
    harness = current;
    const admin = await bootstrapAdmin(current);
    const alice = await inviteAndAccept(current, admin.cookie, 'history-pagination@example.com');
    const providerId = await providerFor(current, admin.cookie);
    const taskId = await createTask(current, alice.cookie, providerId, 'History pagination task');
    const executionIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      executionIds.push(await insertExecution(current, taskId, alice.id));
    }

    const tiedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    const readAt = new Date('2026-01-02T00:00:00.000Z');
    await current.db.pool.query(
      'update executions set created_at = $2, updated_at = $2, read_at = $3 where task_id = $1',
      [taskId, tiedCreatedAt, readAt],
    );
    const orderedRows = await current.db.pool.query<{ id: string }>(
      'select id from executions where task_id = $1 order by created_at desc, id desc',
      [taskId],
    );
    const unreadExecutionId = orderedRows.rows[20]?.id;
    if (!unreadExecutionId) throw new Error('expected an execution at the first item on page two');
    await current.db.pool.query('update executions set read_at = null where id = $1', [unreadExecutionId]);

    const legacy = await current.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/executions`,
      headers: { cookie: alice.cookie },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(Array.isArray(legacy.json())).toBe(true);
    expect(legacy.json()).toHaveLength(20);
    expect(legacy.json()[0]).not.toHaveProperty('createdAt');

    const firstResponse = await current.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/executions?pagination=cursor&limit=20`,
      headers: { cookie: alice.cookie },
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const firstPage = firstResponse.json() as {
      items: Array<{ id: string; createdAt: string; readAt: string | null }>;
      nextCursor: string | null;
    };
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items[0]?.createdAt).toEqual(expect.any(String));
    expect(firstPage.items.map((execution) => execution.id)).toEqual(orderedRows.rows.slice(0, 20).map((row) => row.id));
    expect(firstPage.items.map((execution) => execution.id)).not.toContain(unreadExecutionId);

    const concurrentExecutionId = await insertExecution(current, taskId, alice.id);
    const secondResponse = await current.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/executions?pagination=cursor&limit=20&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      headers: { cookie: alice.cookie },
    });
    expect(secondResponse.statusCode, secondResponse.body).toBe(200);
    const secondPage = secondResponse.json() as {
      items: Array<{ id: string; createdAt: string; readAt: string | null }>;
      nextCursor: string | null;
    };
    expect(secondPage.items.map((execution) => execution.id)).toEqual(orderedRows.rows.slice(20).map((row) => row.id));
    expect(secondPage.items[0]).toMatchObject({ id: unreadExecutionId, readAt: null });
    expect(secondPage.items.map((execution) => execution.id)).not.toContain(concurrentExecutionId);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((execution) => execution.id))).toEqual(new Set(executionIds));
  }, 20_000);
});
