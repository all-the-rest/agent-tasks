import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const taskBody = (providerId: string) => ({
  title: 'Pagination validation task',
  prompt: 'Collect the public opening hours for the city library and cite the source.',
  providerId,
  model: 'mock-researcher',
  enabled: true,
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  allowWebResearch: false,
  notification: 'none',
});

async function providerFor(current: TestHarness, adminCookie: string): Promise<string> {
  const provider = await current.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: {
      name: 'Pagination validation provider',
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
    payload: { apiKey: 'pagination-validation-key-123' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  return providerId;
}

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
  createdAt: Date,
): Promise<string> {
  const id = randomUUID();
  await current.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, "trigger", created_at, updated_at)
     values ($1, $2, $3, 'Pagination validation execution', 'completed', 'manual', $4, $4)`,
    [id, taskId, ownerId, createdAt],
  );
  return id;
}

async function setup(): Promise<{
  current: TestHarness;
  alice: { cookie: string; id: string };
  bob: { cookie: string; id: string };
  providerId: string;
}> {
  const current = await createHarness();
  harness = current;
  const admin = await bootstrapAdmin(current);
  const alice = await inviteAndAccept(current, admin.cookie, 'pagination-validation-alice@example.com');
  const bob = await inviteAndAccept(current, admin.cookie, 'pagination-validation-bob@example.com');
  const providerId = await providerFor(current, admin.cookie);
  return { current, alice, bob, providerId };
}

describe('legacy pagination validation', () => {
  it('rejects malformed task list limits with the cursor-pagination error contract', async () => {
    const { current, alice } = await setup();
    for (const limit of ['abc', 'NaN', '-1', '0', '2.5', 'Infinity']) {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/tasks?status=active&limit=${encodeURIComponent(limit)}`,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode, `${limit}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'bad_request', message: 'invalid pagination limit' },
      });
    }

    const cursor = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?pagination=cursor&limit=abc',
      headers: { cookie: alice.cookie },
    });
    expect(cursor.statusCode, cursor.body).toBe(400);
    expect(cursor.json()).toMatchObject({
      error: { code: 'bad_request', message: 'invalid pagination limit' },
    });
  });

  it('keeps legacy task defaults and the 100-item clamp for old clients', async () => {
    const { current, alice, providerId } = await setup();
    for (const title of ['First task', 'Second task', 'Third task']) {
      await createTask(current, alice.cookie, providerId, title);
    }

    const defaulted = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?status=active',
      headers: { cookie: alice.cookie },
    });
    expect(defaulted.statusCode, defaulted.body).toBe(200);
    expect(defaulted.json()).toHaveLength(3);

    const limited = await current.app.inject({
      method: 'GET',
      url: '/api/tasks?status=active&limit=2',
      headers: { cookie: alice.cookie },
    });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json()).toHaveLength(2);

    // Oversized limits were clamped before this change and must stay accepted.
    for (const limit of ['1000', '1e2']) {
      const clamped = await current.app.inject({
        method: 'GET',
        url: `/api/tasks?status=active&limit=${limit}`,
        headers: { cookie: alice.cookie },
      });
      expect(clamped.statusCode, clamped.body).toBe(200);
      expect(clamped.json()).toHaveLength(3);
    }
  });

  it('rejects malformed execution limits and before timestamps with 400', async () => {
    const { current, alice, providerId } = await setup();
    const taskId = await createTask(current, alice.cookie, providerId, 'Execution pagination task');
    await insertExecution(current, taskId, alice.id, new Date('2026-01-01T00:00:00.000Z'));

    for (const limit of ['abc', '-5', '1.5']) {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/executions?limit=${encodeURIComponent(limit)}`,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode, `${limit}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'bad_request', message: 'invalid pagination limit' },
      });
    }

    for (const before of ['not-a-date', '2026-13-40T00:00:00Z', '2026-02-31T00:00:00Z', '']) {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/executions?before=${encodeURIComponent(before)}`,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode, `${before}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'bad_request', message: 'invalid pagination timestamp' },
      });
    }
  });

  it('still filters valid before timestamps and keeps the legacy default', async () => {
    const { current, alice, providerId } = await setup();
    const taskId = await createTask(current, alice.cookie, providerId, 'Timestamp filter task');
    const oldestId = await insertExecution(current, taskId, alice.id, new Date('2026-01-01T00:00:00.000Z'));
    const middleId = await insertExecution(current, taskId, alice.id, new Date('2026-01-15T00:00:00.000Z'));
    const newestId = await insertExecution(current, taskId, alice.id, new Date('2026-02-01T00:00:00.000Z'));

    const defaulted = await current.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/executions`,
      headers: { cookie: alice.cookie },
    });
    expect(defaulted.statusCode, defaulted.body).toBe(200);
    expect(defaulted.json().map((execution: { id: string }) => execution.id)).toEqual([newestId, middleId, oldestId]);

    const olderThan = async (before: string): Promise<string[]> => {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/executions?before=${encodeURIComponent(before)}`,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().map((execution: { id: string }) => execution.id);
    };

    expect(await olderThan('2027-01-01T00:00:00.000Z')).toEqual([newestId, middleId, oldestId]);
    expect(await olderThan('2026-02-01T00:00:00.000Z')).toEqual([middleId, oldestId]);
    expect(await olderThan('2026-01-02T00:00:00.000Z')).toEqual([oldestId]);
    expect(await olderThan('2025-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('rejects malformed global execution limits and preserves owner scoping', async () => {
    const { current, alice, bob, providerId } = await setup();
    const taskId = await createTask(current, alice.cookie, providerId, 'Owner-scoped pagination task');
    await insertExecution(current, taskId, alice.id, new Date('2026-01-01T00:00:00.000Z'));

    for (const limit of ['abc', '-10']) {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/executions?limit=${encodeURIComponent(limit)}`,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode, `${limit}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'bad_request', message: 'invalid pagination limit' },
      });
    }

    const oversized = await current.app.inject({
      method: 'GET',
      url: '/api/executions?limit=1000',
      headers: { cookie: alice.cookie },
    });
    expect(oversized.statusCode, oversized.body).toBe(200);
    expect(oversized.json()).toHaveLength(1);

    // Another owner's task must stay invisible, so its execution pagination fails
    // with 404 before any parameter validation can reveal the task's existence.
    for (const query of ['limit=abc', 'before=not-a-date']) {
      const response = await current.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/executions?${query}`,
        headers: { cookie: bob.cookie },
      });
      expect(response.statusCode, response.body).toBe(404);
    }

    const bobExecutions = await current.app.inject({
      method: 'GET',
      url: '/api/executions',
      headers: { cookie: bob.cookie },
    });
    expect(bobExecutions.statusCode, bobExecutions.body).toBe(200);
    expect(bobExecutions.json()).toEqual([]);
  });
});
