import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { Executor } from '../../apps/worker/src/executor';
import type { WorkerEnv } from '../../apps/worker/src/env';
import { bootstrapAdmin, createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';
import { FakeOpenCodeProvisioner } from '../helpers/fake-opencode';

let harness: TestHarness;
let adminCookie: string;
let openCode: FakeOpenCodeProvisioner;

/** A non-loopback address the API will accept for an http provider URL. */
function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

async function startModelCatalogServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (parsed.pathname !== '/v1/models') {
      response.writeHead(404).end();
      return;
    }
    // The OpenAI /models route carries no capability metadata; the adapter must
    // therefore record supportsTools=false until an administrator pins it.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'catalog-model' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address() as AddressInfo;
  const host = lanAddress() ?? '127.0.0.1';
  return { url: `http://${host}:${port}/v1`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: harness.env.DATABASE_URL,
    SECRETS_ENCRYPTION_KEY: harness.env.SECRETS_ENCRYPTION_KEY,
    RUNNER_URL: 'http://127.0.0.1:1',
    RUNNER_TOKEN: 'provider-catalog-runner-token-0123456789',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    WORKER_CONCURRENCY: 1,
    OPENCODE_PROVISIONER_URL: 'http://fake-opencode.invalid:4090',
    OPENCODE_PROVISIONER_TOKEN: 'integration-fake-provisioner-token-0123456789',
    LOG_LEVEL: 'silent',
  };
}

const bossStub = { send: async () => 'job-id' } as unknown as PgBoss;

function makeExecutor(): Executor {
  return new Executor({
    db: harness.db.db,
    env: workerEnv(),
    boss: bossStub,
    workerId: 'provider-catalog-worker',
    openCodeRunner: openCode.runner(harness.db.db),
  });
}

async function queueExecution(input: { taskId: string; ownerId: string; providerId: string; model: string }): Promise<string> {
  const executionId = randomUUID();
  await harness.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, "trigger", model, provider_id)
     values ($1,$2,$3,'Catalog task','queued','manual',$4,$5)`,
    [executionId, input.taskId, input.ownerId, input.model, input.providerId],
  );
  return executionId;
}

async function createProvider(baseUrl: string): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: {
      name: `Catalog provider ${randomUUID()}`,
      kind: 'openai-compatible',
      // The normal create form starts without declared models.
      config: { baseUrl, models: [] },
      enabled: true,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const providerId = created.json().id as string;
  const credential = await harness.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${providerId}/credentials`,
    headers: { cookie: adminCookie },
    payload: { apiKey: 'catalog-test-key-123' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  return providerId;
}

async function createTask(input: {
  providerId: string;
  model?: string;
  allowWebResearch?: boolean;
  memoryMode?: 'auto' | 'suggest' | 'off';
}): Promise<{ statusCode: number; body: string; id?: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: adminCookie },
    payload: {
      title: `Catalog task ${randomUUID()}`,
      prompt: 'Answer from the provider catalog without inventing a model.',
      providerId: input.providerId,
      model: input.model ?? 'catalog-model',
      enabled: true,
      schedule: { preset: 'once', timezone: 'Europe/Vienna', runAt: new Date(Date.now() + 3_600_000).toISOString() },
      allowWebResearch: input.allowWebResearch ?? false,
      notification: 'none',
      memorySettings: { mode: input.memoryMode ?? 'off', contextBytes: 12_000 },
    },
  });
  return { statusCode: response.statusCode, body: response.body, ...(response.statusCode === 201 ? { id: response.json().id as string } : {}) };
}

beforeAll(async () => {
  harness = await createHarness();
  adminCookie = (await bootstrapAdmin(harness)).cookie;
  openCode = new FakeOpenCodeProvisioner();
  await openCode.start();
}, 120_000);

afterAll(async () => {
  await openCode.close();
  await harness.close();
});

const lan = lanAddress();

describe('persisted provider catalog and tool capability', () => {
  it.skipIf(!lan)('creates a provider, refreshes the discovered catalog and runs against it', async () => {
    const catalog = await startModelCatalogServer();
    try {
      const providerId = await createProvider(catalog.url);

      // Normal refresh writes provider_models; the declared list stays empty.
      const refreshed = await harness.app.inject({
        method: 'POST',
        url: `/api/admin/providers/${providerId}/models/refresh`,
        headers: { cookie: adminCookie },
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json().models).toEqual([
        { id: 'catalog-model', label: 'catalog-model', supportsTools: false },
      ]);

      const adminView = (await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } }))
        .json().find((provider: { id: string }) => provider.id === providerId);
      expect(adminView.executable).toBe(true);
      expect(adminView.models).toEqual([
        { id: 'catalog-model', label: 'catalog-model', supportsTools: false },
      ]);
      const userView = (await harness.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: adminCookie } }))
        .json().find((provider: { id: string }) => provider.id === providerId);
      expect(userView.models).toEqual([
        { id: 'catalog-model', label: 'catalog-model', supportsTools: false },
      ]);

      // A task that needs no tools is allowed and the worker runs it with the
      // discovered catalog (previously config.models was empty and provisioning
      // failed with "Task model is not configured on its provider").
      const plain = await createTask({ providerId });
      expect(plain.statusCode, plain.body).toBe(201);
      const plainExecution = await queueExecution({ taskId: plain.id!, ownerId: await ownerOf(plain.id!), providerId, model: 'catalog-model' });
      openCode.plans.set(plainExecution, { answer: 'Catalog-backed answer.' });
      await makeExecutor().handle(plainExecution);
      const plainRun = await harness.db.pool.query('select status, error, report from executions where id = $1', [plainExecution]);
      expect(plainRun.rows[0].status, plainRun.rows[0].error).toBe('completed');
      expect(plainRun.rows[0].report.markdown).toContain('Catalog-backed answer.');
      expect(openCode.requests.at(-1)?.providerContext.config).toMatchObject({
        models: [expect.objectContaining({ id: 'catalog-model', supportsTools: false })],
      });

      // Research or memory would need tools; the discovered false must be a visible
      // refusal, not a silent tool-less run.
      const research = await createTask({ providerId, allowWebResearch: true });
      expect(research.statusCode, research.body).toBe(400);
      expect(research.body).toContain('is not marked tool-capable');
      const memory = await createTask({ providerId, memoryMode: 'auto' });
      expect(memory.statusCode, memory.body).toBe(400);
      expect(memory.body).toContain('is not marked tool-capable');

      // The admin capability toggle is a normal PATCH of config.models. It must win
      // over the discovered false for the API, the worker and the provisioner.
      const patched = await harness.app.inject({
        method: 'PATCH',
        url: `/api/admin/providers/${providerId}`,
        headers: { cookie: adminCookie },
        payload: {
          config: {
            baseUrl: 'https://llm.example/v1',
            models: [{ id: 'catalog-model', supportsTools: true }],
          },
        },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const patchedView = (await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } }))
        .json().find((provider: { id: string }) => provider.id === providerId);
      expect(patchedView.models).toEqual([
        { id: 'catalog-model', label: 'catalog-model', supportsTools: true },
      ]);

      const capable = await createTask({ providerId, memoryMode: 'auto' });
      expect(capable.statusCode, capable.body).toBe(201);
      const capableExecution = await queueExecution({ taskId: capable.id!, ownerId: await ownerOf(capable.id!), providerId, model: 'catalog-model' });
      openCode.plans.set(capableExecution, { answer: 'Capability-aware answer.' });
      await makeExecutor().handle(capableExecution);
      const capableRun = await harness.db.pool.query('select status, error from executions where id = $1', [capableExecution]);
      expect(capableRun.rows[0].status, capableRun.rows[0].error).toBe('completed');
      expect(openCode.requests.at(-1)?.providerContext.config).toMatchObject({
        models: [expect.objectContaining({ id: 'catalog-model', supportsTools: true })],
      });
    } finally {
      await catalog.close();
    }
  }, 120_000);

  it('refuses tasks on provider kinds the worker cannot execute and keeps the data', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: { name: `Ollama ${randomUUID()}`, kind: 'ollama', config: {} },
    });
    expect(created.statusCode, created.body).toBe(201);
    const providerId = created.json().id as string;

    const userList = await harness.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: adminCookie } });
    expect(userList.json().find((provider: { id: string }) => provider.id === providerId).executable).toBe(false);

    const refused = await createTask({ providerId, model: 'llama3.2:1b' });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.body).toContain('not supported for task execution');

    // A task persisted before the restriction (or created out of band) may still be
    // read and edited, but a run is refused with a clear response.
    const owner = await harness.db.pool.query('select id from "user" limit 1');
    const taskId = randomUUID();
    await harness.db.pool.query(
      `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification, memory_settings)
       values ($1,$2,'Legacy ollama','Legacy task prompt for an unsupported provider.',$3,'llama3.2:1b',false,$4,'Europe/Vienna',$5,false,'none','{}')`,
      [taskId, owner.rows[0].id, providerId, JSON.stringify({ preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 0 }), JSON.stringify({ maxDurationSec: 60, maxAgentSteps: 4, maxPageVisits: 0, maxOutputBytes: 50_000, maxToolCalls: 4, maxSearchQueries: 0 })],
    );
    const read = await harness.app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: { cookie: adminCookie } });
    expect(read.statusCode, read.body).toBe(200);
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { title: 'Renamed legacy ollama' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const moved = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { providerId, model: 'llama3.2:1b' },
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.body).toContain('not supported for task execution');
    const run = await harness.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/run`, headers: { cookie: adminCookie } });
    expect(run.statusCode, run.body).toBe(400);
    expect(run.body).toContain('not supported for task execution');

    const resume = await harness.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume`, headers: { cookie: adminCookie } });
    expect(resume.statusCode, resume.body).toBe(400);
    expect(resume.body).toContain('not supported for task execution');

    const duplicate = await harness.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/duplicate`, headers: { cookie: adminCookie } });
    expect(duplicate.statusCode, duplicate.body).toBe(400);
    expect(duplicate.body).toContain('not supported for task execution');

    // Retrying a failed execution must not bypass the same check.
    const failedExecutionId = randomUUID();
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, "trigger", provider_id, model)
       values ($1,$2,$3,'Legacy ollama','failed','scheduled',$4,'llama3.2:1b')`,
      [failedExecutionId, taskId, owner.rows[0].id, providerId],
    );
    const retry = await harness.app.inject({ method: 'POST', url: `/api/executions/${failedExecutionId}/retry`, headers: { cookie: adminCookie } });
    expect(retry.statusCode, retry.body).toBe(400);
    expect(retry.body).toContain('not supported for task execution');

    // The provider and the task were not deleted or rewritten by the refusals.
    const stored = await harness.db.pool.query('select kind from providers where id = $1', [providerId]);
    expect(stored.rows[0]?.kind).toBe('ollama');
    const task = await harness.db.pool.query('select title, provider_id from tasks where id = $1', [taskId]);
    expect(task.rows[0]).toMatchObject({ title: 'Renamed legacy ollama', provider_id: providerId });
  }, 120_000);
});

async function ownerOf(taskId: string): Promise<string> {
  const rows = await harness.db.pool.query('select owner_id from tasks where id = $1', [taskId]);
  return rows.rows[0].owner_id as string;
}
