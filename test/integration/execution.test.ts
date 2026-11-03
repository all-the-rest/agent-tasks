import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { SecretBox } from '@agent-tasks/ai-providers';
import { Executor } from '../../apps/worker/src/executor';
import type { WorkerEnv } from '../../apps/worker/src/env';
import { bootstrapAdmin, createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';
import { FakeOpenCodeProvisioner } from '../helpers/fake-opencode';

let RUNNER_PORT = 0;
const RUNNER_TOKEN = 'integration-runner-token-0123456789';

let harness: TestHarness;
let openCode: FakeOpenCodeProvisioner;
let search: { url: string; close: () => Promise<void> };
let runner: ChildProcess | null = null;
let runnerLogs = '';

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`service at ${url} did not become ready`);
}

beforeAll(async () => {
  harness = await createHarness();
  openCode = new FakeOpenCodeProvisioner();
  await openCode.start();
  search = await startFakeSearch();
  RUNNER_PORT = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || !address) return reject(new Error('no port'));
      const port = address.port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });

  runner = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    cwd: new URL('../../services/browser-runner', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(RUNNER_PORT),
      RUNNER_TOKEN,
      RUNNER_ALLOW_HTTP: 'true',
      RUNNER_ALLOWED_PORTS: '80,443',
      // This host has no user namespaces, so Chromium's sandbox cannot start here.
      // The container keeps RUNNER_CHROMIUM_SANDBOX=true (see compose.yaml).
      RUNNER_CHROMIUM_SANDBOX: 'false',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runner.stdout?.on('data', (chunk: Buffer) => {
    runnerLogs += chunk.toString('utf8');
  });
  const child = runner;
  runner.stderr?.on('data', (chunk: Buffer) => {
    runnerLogs += chunk.toString('utf8');
  });
  await waitFor(`http://127.0.0.1:${RUNNER_PORT}/healthz`, 60_000).catch((error: Error) => {
    throw new Error(`${error.message}\nrunner log:\n${runnerLogs}`);
  });
  if (child.exitCode !== null) throw new Error(`runner exited early: ${runnerLogs}`);
}, 120_000);

afterEach(async () => {
  // Every execution must release its browser session, otherwise the runner would
  // fill up across scheduled runs.
  const health = await fetch(`http://127.0.0.1:${RUNNER_PORT}/healthz`).then((response) => response.json());
  expect(health.sessions, runnerLogs.slice(-3000)).toBe(0);
});

afterAll(async () => {
  runner?.kill('SIGTERM');
  await openCode.close();
  await search.close();
  await harness.close();
});

async function seedTask(options: { limits?: Record<string, number>; allowWebResearch?: boolean; baseUrl?: string; notification?: 'none' | 'email'; apiKey?: string; model?: string; supportsTools?: boolean; memoryMode?: 'auto' | 'suggest' | 'off' } = {}): Promise<{ taskId: string; executionId: string; ownerId: string; providerId: string }> {
  const model = options.model ?? 'mock-researcher';
  const owner = await harness.db.pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'Owner',$2,true,'USER') returning id`, [randomUUID(), `owner-${randomUUID()}@example.com`]);
  const ownerId = owner.rows[0].id;
  const provider = await harness.db.pool.query(
    `insert into providers (id, name, kind, enabled, is_default, config) values ($1,$2,'openai-compatible',true,true,$3) returning id`,
    [randomUUID(), `Fake OpenCode provider ${randomUUID()}`, JSON.stringify({ baseUrl: options.baseUrl ?? 'https://provider.invalid/v1', models: [{ id: model.split('#')[0], supportsTools: options.supportsTools ?? true }], userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session' })],
  );
  const box = new SecretBox(harness.env.SECRETS_ENCRYPTION_KEY);
  await harness.db.pool.query(
    `insert into provider_credentials (id, provider_id, owner_id, label, ciphertext) values ($1,$2,null,'shared',$3)`,
    [randomUUID(), provider.rows[0].id, box.encrypt(options.apiKey ?? 'mock-api-key')],
  );

  await harness.db.pool.query(
    `insert into system_settings (id, values) values (1, $1)
     on conflict (id) do update set values = excluded.values`,
    [JSON.stringify({ searchProvider: 'none', defaultTimezone: 'Europe/Vienna', allowRegistration: false, maxConcurrentExecutionsPerUser: 2, maxTaskExecutionsPerDay: 50, browserAllowHttp: true, browserAllowedPorts: [80, 443] })],
  );

  const taskId = randomUUID();
  const limits = options.limits ?? { maxDurationSec: 90, maxAgentSteps: 6, maxPageVisits: 3, maxOutputBytes: 100000, maxToolCalls: 8, maxSearchQueries: 2 };
  await harness.db.pool.query(
    `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification, memory_settings)
     values ($1,$2,'Live research','What does example.com say about itself? Cite the page.',$3,$4,true,$5,'Europe/Vienna',$6,$7,$8,$9)`,
    [taskId, ownerId, provider.rows[0].id, model, JSON.stringify({ preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 0 }), JSON.stringify(limits), options.allowWebResearch ?? true, options.notification ?? 'none', JSON.stringify({ mode: options.memoryMode ?? 'auto', contextBytes: 12_000 })],
  );
  const executionId = randomUUID();
  await harness.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'Live research','queued','manual',$4,$5)`,
    [executionId, taskId, ownerId, model, provider.rows[0].id],
  );
  return { taskId, executionId, ownerId, providerId: provider.rows[0].id as string };
}

/** Queue a second execution for an existing task, as the scheduler would. */
async function queueExecution(input: { taskId: string; ownerId: string; providerId: string }): Promise<string> {
  const executionId = randomUUID();
  await harness.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'Live research','queued','manual','mock-researcher',$4)`,
    [executionId, input.taskId, input.ownerId, input.providerId],
  );
  return executionId;
}

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: harness.env.DATABASE_URL,
    SECRETS_ENCRYPTION_KEY: harness.env.SECRETS_ENCRYPTION_KEY,
    RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
    RUNNER_TOKEN,
    PUBLIC_BASE_URL: 'http://localhost:8080',
    WORKER_CONCURRENCY: 1,
    OPENCODE_PROVISIONER_URL: 'http://fake-opencode.invalid:4090',
    OPENCODE_PROVISIONER_TOKEN: 'integration-fake-provisioner-token-0123456789',
    SEARXNG_URL: search.url,
    LOG_LEVEL: 'silent',
  };
}

function makeExecutor(options: { mailer?: ConstructorParameters<typeof Executor>[0]['mailer']; workerId?: string } = {}): Executor {
  return new Executor({
    db: harness.db.db,
    env: workerEnv(),
    boss: bossStub,
    workerId: options.workerId ?? 'test-worker',
    ...(options.mailer ? { mailer: options.mailer } : {}),
    openCodeRunner: openCode.runner(harness.db.db),
  });
}

const bossStub = { send: async () => 'job-id' } as unknown as PgBoss;

/** Minimal real SearXNG-compatible JSON endpoint with three public URLs. */
async function startFakeSearch(): Promise<{ url: string; close: () => Promise<void> }> {
  const urls = ['https://example.com/', 'https://example.org/', 'https://example.net/'];
  const server = createHttpServer((request, response) => {
    const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (parsed.pathname !== '/search' || parsed.searchParams.get('format') !== 'json') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        results: urls.map((url, index) => ({ title: `Reference ${index + 1}`, url, content: `Stable reference page ${index + 1}.`, engine: 'fixture' })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('provisioned execution integration (fake runtime and provider, real Executor and persistence)', () => {
  it('sends the completion e-mail with the agent image-text block', async () => {
    const { executionId, ownerId } = await seedTask({ allowWebResearch: false, notification: 'email' });
    openCode.plans.set(executionId, {
      answer: 'Revenue grew 12% in the last quarter.',
      emailDsl: [
        '# Weekly report',
        '',
        'Revenue grew 12% in the last quarter.',
        '',
        ':::imageText side=left image=https://example.com/chart.png alt="Revenue chart"',
        'Revenue grew 12% in the last quarter.',
        ':::',
      ].join('\n'),
    });
    const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
    const mailer = {
      kind: 'log' as const,
      async send(message: { to: string; subject: string; text: string; html?: string }) {
        sent.push(message);
      },
    };
    await makeExecutor({ mailer }).handle(executionId);

    expect(sent).toHaveLength(1);
    const owner = await harness.db.pool.query('select email from "user" where id = $1', [ownerId]);
    expect(sent[0]?.to).toBe(owner.rows[0].email);
    expect(sent[0]?.subject).toContain('Task completed');
    expect(sent[0]?.html).toContain('https://example.com/chart.png');
    expect(sent[0]?.html).toContain('Revenue grew 12% in the last quarter.');
    expect(sent[0]?.html).toContain('Revenue chart');
    expect(sent[0]?.text).toContain('[image] https://example.com/chart.png');
    expect(sent[0]?.html).toContain(`/executions/${executionId}`);

    const report = await harness.db.pool.query('select report from executions where id = $1', [executionId]);
    expect(report.rows[0].report.email.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'imageText']);
    expect(report.rows[0].report.email.blocks[2]).toMatchObject({ type: 'imageText', side: 'left' });
  });

  it('sends a change notification only when the report text actually changed', async () => {
    const { taskId, executionId, ownerId, providerId } = await seedTask({ allowWebResearch: false, notification: 'email_on_change' });
    const sent: Array<{ subject: string }> = [];
    const mailer = {
      kind: 'log' as const,
      async send(message: { to: string; subject: string; text: string; html?: string }) {
        sent.push(message);
      },
    };
    const executor = makeExecutor({ mailer });

    openCode.plans.set(executionId, { answer: 'Stable answer.' });
    await executor.handle(executionId);
    expect(sent).toHaveLength(1);

    // Same text on the next run is a quiet run: the execution still completes and
    // records the comparison, but no e-mail is sent.
    const unchangedId = await queueExecution({ taskId, ownerId, providerId });
    openCode.plans.set(unchangedId, { answer: 'Stable answer.' });
    await executor.handle(unchangedId);
    expect(sent).toHaveLength(1);
    const unchanged = await harness.db.pool.query('select status, report from executions where id = $1', [unchangedId]);
    expect(unchanged.rows[0].status).toBe('completed');
    expect(unchanged.rows[0].report.change).toMatchObject({ status: 'unchanged', previousExecutionId: executionId });

    // A changed report is delivered.
    const changedId = await queueExecution({ taskId, ownerId, providerId });
    openCode.plans.set(changedId, { answer: 'The situation changed since the last run.' });
    await executor.handle(changedId);
    expect(sent).toHaveLength(2);
    const changed = await harness.db.pool.query('select report from executions where id = $1', [changedId]);
    expect(changed.rows[0].report.change.status).toBe('changed');
  }, 120_000);

  it('runs the provisioned OpenCode path, calls the real browser bridge and persists a sourced report', async () => {
    const { taskId, executionId } = await seedTask();
    openCode.plans.set(executionId, { searchQuery: 'example.com research', openUrls: ['https://example.com/'] });
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, report, usage, error, duration_ms from executions where id = $1', [executionId]);
    const row = execution.rows[0];
    expect(row.status, row.error).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.report.markdown).toContain('Findings');
    expect(row.report.sources.length).toBeGreaterThan(0);
    expect(row.report.sources[0].url).toMatch(/^https:\/\//);
    expect(row.usage.totalTokens).toBeGreaterThan(0);

    const steps = await harness.db.pool.query('select tool, ok from execution_steps where execution_id = $1 order by step', [executionId]);
    expect(steps.rows.map((step) => step.tool)).toEqual(['opencode']);
    expect(steps.rows.every((step) => step.ok)).toBe(true);
    expect(openCode.toolCalls.filter((call) => call.executionId === executionId).map((call) => call.name)).toEqual(['search_web', 'open_url']);

    const sources = await harness.db.pool.query('select url, confidence from execution_sources where execution_id = $1', [executionId]);
    expect(sources.rows.length).toBeGreaterThan(0);
    expect(sources.rows[0].confidence).toBe('verified');

    const task = await harness.db.pool.query('select last_run_at from tasks where id = $1', [taskId]);
    expect(task.rows[0].last_run_at).not.toBeNull();
  }, 120_000);

  it('visits three distinct public pages and persists every one as a source', async () => {
    const { executionId } = await seedTask({
      limits: { maxDurationSec: 120, maxAgentSteps: 6, maxPageVisits: 3, maxOutputBytes: 100000, maxToolCalls: 8, maxSearchQueries: 2 },
    });
    await harness.db.pool.query(
      `update system_settings set values = jsonb_set(jsonb_set(values, '{searchProvider}', '"searxng"'), '{searchBaseUrl}', to_jsonb($1::text)) where id = 1`,
      [search.url],
    );
    openCode.plans.set(executionId, {
      searchQuery: 'three examples',
      openUrls: ['https://example.com/', 'https://example.org/', 'https://example.net/'],
    });
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, error, report from executions where id = $1', [executionId]);
    expect(execution.rows[0].status, execution.rows[0].error).toBe('completed');
    const sources = await harness.db.pool.query('select distinct url from execution_sources where execution_id = $1', [executionId]);
    expect(sources.rows.map((row) => row.url).sort()).toEqual([
      'https://example.com/',
      'https://example.net/',
      'https://example.org/',
    ]);
    expect(openCode.toolCalls.filter((call) => call.executionId === executionId && call.name === 'open_url' && !call.isError)).toHaveLength(3);
    expect(execution.rows[0].report.markdown).toContain('OpenCode report');
  }, 180_000);

  it('runs a task whose model carries a reasoning variant through the provisioned runtime', async () => {
    const { executionId } = await seedTask({ allowWebResearch: false, model: 'mock-researcher#high' });
    openCode.plans.set(executionId, { answer: 'Variant run completed.' });
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, error, model, report from executions where id = $1', [executionId]);
    expect(execution.rows[0].status, execution.rows[0].error).toBe('completed');
    // The execution keeps the user-facing selection; the runtime receives base + variant.
    expect(execution.rows[0].model).toBe('mock-researcher#high');
    expect(execution.rows[0].report.markdown).toContain('Variant run completed.');
    expect(openCode.requests.find((entry) => entry.lease.executionId === executionId)?.model)
      .toEqual({ id: 'mock-researcher', variant: 'high' });
  }, 120_000);

  it('fails an execution with an unsupported model variant before provisioning', async () => {
    const { executionId } = await seedTask({ allowWebResearch: false, model: 'mock-researcher#extreme' });
    const before = openCode.requests.length;
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
    expect(execution.rows[0].status).toBe('failed');
    expect(execution.rows[0].error).toContain('unknown model variant "extreme"');
    expect(openCode.requests).toHaveLength(before);
  }, 120_000);

  it('rejects unsupported provider kinds without mapping them to OpenAI-compatible', async () => {
    const { executionId, taskId } = await seedTask();
    await harness.db.pool.query(
      `update providers set kind = 'ollama' where id = (select provider_id from tasks where id = $1)`,
      [taskId],
    );
    const before = openCode.requests.length;
    await makeExecutor().handle(executionId);
    const execution = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
    expect(execution.rows[0].status).toBe('failed');
    expect(execution.rows[0].error).toMatch(/provider kind ollama is not supported/i);
    expect(openCode.requests).toHaveLength(before);
  }, 120_000);

  it('refuses a task that needs tools when the model is not explicitly tool-capable', async () => {
    const { executionId } = await seedTask({ allowWebResearch: false, supportsTools: false, memoryMode: 'auto' });
    const before = openCode.requests.length;
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
    expect(execution.rows[0].status).toBe('failed');
    expect(execution.rows[0].error).toContain('is not marked tool-capable');
    // Fail before provisioning: no runtime was created and no provider call happened.
    expect(openCode.requests).toHaveLength(before);
  }, 120_000);

  it('runs a tool-less model when the task requests no tools at all', async () => {
    const { executionId } = await seedTask({ allowWebResearch: false, supportsTools: false, memoryMode: 'off', notification: 'none' });
    openCode.plans.set(executionId, { answer: 'Plain answer without tools.' });
    const before = openCode.requests.length;
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, error, report from executions where id = $1', [executionId]);
    expect(execution.rows[0].status, execution.rows[0].error).toBe('completed');
    expect(execution.rows[0].report.markdown).toContain('Plain answer without tools.');
    // The provisioner still receives the persisted catalog entry (with its explicit
    // false capability) instead of an empty `config.models`.
    expect(openCode.requests[before]?.providerContext.config)
      .toMatchObject({ models: [expect.objectContaining({ id: 'mock-researcher', supportsTools: false })] });
  }, 120_000);

  it('blocks a loopback URL from the agent even when the model asks for it', async () => {
    const { executionId } = await seedTask();
    openCode.plans.set(executionId, { openUrls: [`http://127.0.0.1:${RUNNER_PORT}/healthz`] });
    await makeExecutor().handle(executionId);

    const execution = await harness.db.pool.query('select status, report from executions where id = $1', [executionId]);
    const call = openCode.toolCalls.find((entry) => entry.executionId === executionId && entry.name === 'open_url');
    expect(call?.isError).toBe(true);
    expect(call?.text).toMatch(/port|blocked|private|loopback|not public|not allowed/i);
    expect(execution.rows[0].status).toBe('completed');
    expect(execution.rows[0].report.sources).toEqual([]);
  }, 120_000);

  it('passes only the current owner-resolved key to the provisioner and keeps revoked keys out', async () => {
    const first = await seedTask({ allowWebResearch: false, apiKey: 'first-shared-key-123' });
    const { cookie } = await bootstrapAdmin(harness);
    const run = async (executionId: string) => {
      await makeExecutor().handle(executionId);
      const result = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
      return result.rows[0] as { status: string; error: string | null };
    };
    openCode.requests.length = 0;

    expect((await run(first.executionId)).status).toBe('completed');
    expect(openCode.requests.map((request) => request.providerContext.apiKey)).toEqual(['first-shared-key-123']);

    const rotated = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/providers/${first.providerId}/credentials`,
      headers: { cookie },
      payload: { apiKey: 'rotated-shared-key-456', label: 'shared' },
    });
    expect(rotated.statusCode, rotated.body).toBe(201);
    const secondExecution = await queueExecution(first);
    expect((await run(secondExecution)).status).toBe('completed');
    expect(openCode.requests.map((request) => request.providerContext.apiKey)).toEqual(['first-shared-key-123', 'rotated-shared-key-456']);

    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `/api/admin/providers/${first.providerId}/credentials`,
      headers: { cookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);
    const thirdExecution = await queueExecution(first);
    const third = await run(thirdExecution);
    expect(third.status).toBe('failed');
    expect(third.error ?? '').not.toContain('rotated-shared-key-456');
    expect(third.error ?? '').not.toContain('first-shared-key-123');
    expect(openCode.requests.map((request) => request.providerContext.apiKey)).toEqual(['first-shared-key-123', 'rotated-shared-key-456', undefined]);
  }, 120_000);
});
