import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { SecretBox } from '@agent-tasks/ai-providers';
import { createMockOpenAiServer } from '@agent-tasks/mock-openai';
import type { MockServer } from '@agent-tasks/mock-openai';
import { Executor } from '../../apps/worker/src/executor';
import type { WorkerEnv } from '../../apps/worker/src/env';
import { createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let RUNNER_PORT = 0;
const RUNNER_TOKEN = 'integration-runner-token-0123456789';

let harness: TestHarness;
let mock: MockServer | null = null;
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
  mock = await createMockOpenAiServer({ researchSteps: 2 });
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
  await mock?.close();
  await harness.close();
});

async function seedTask(options: { limits?: Record<string, number>; allowWebResearch?: boolean } = {}): Promise<{ taskId: string; executionId: string; ownerId: string }> {
  const owner = await harness.db.pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'Owner',$2,true,'USER') returning id`, [randomUUID(), `owner-${randomUUID()}@example.com`]);
  const ownerId = owner.rows[0].id;
  const provider = await harness.db.pool.query(
    `insert into providers (id, name, kind, enabled, is_default, config) values ($1,$2,'openai-compatible',true,true,$3) returning id`,
    [randomUUID(), `Mock OpenAI ${randomUUID()}`, JSON.stringify({ baseUrl: mock?.url, models: [{ id: 'mock-researcher', supportsTools: true }], userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session' })],
  );
  const box = new SecretBox(harness.env.SECRETS_ENCRYPTION_KEY);
  await harness.db.pool.query(
    `insert into provider_credentials (id, provider_id, owner_id, label, ciphertext) values ($1,$2,null,'shared',$3)`,
    [randomUUID(), provider.rows[0].id, box.encrypt('mock-api-key')],
  );

  await harness.db.pool.query(
    `insert into system_settings (id, values) values (1, $1)
     on conflict (id) do update set values = excluded.values`,
    [JSON.stringify({ searchProvider: 'none', defaultTimezone: 'Europe/Vienna', allowRegistration: false, maxConcurrentExecutionsPerUser: 2, maxTaskExecutionsPerDay: 50, browserAllowHttp: true, browserAllowedPorts: [80, 443] })],
  );

  const taskId = randomUUID();
  const limits = options.limits ?? { maxDurationSec: 90, maxAgentSteps: 6, maxPageVisits: 3, maxOutputBytes: 100000, maxToolCalls: 8, maxSearchQueries: 2 };
  await harness.db.pool.query(
    `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification)
     values ($1,$2,'Live research','What does example.com say about itself? Cite the page.',$3,'mock-researcher',true,$4,'Europe/Vienna',$5,$6,'none')`,
    [taskId, ownerId, provider.rows[0].id, JSON.stringify({ preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 0 }), JSON.stringify(limits), options.allowWebResearch ?? true],
  );
  const executionId = randomUUID();
  await harness.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'Live research','queued','manual','mock-researcher',$4)`,
    [executionId, taskId, ownerId, provider.rows[0].id],
  );
  return { taskId, executionId, ownerId };
}

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: harness.env.DATABASE_URL,
    SECRETS_ENCRYPTION_KEY: harness.env.SECRETS_ENCRYPTION_KEY,
    RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
    RUNNER_TOKEN,
    WORKER_CONCURRENCY: 1,
    LOG_LEVEL: 'silent',
  };
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

describe('execution end to end (mock model, real browser, real network policy)', () => {
  it('runs the agent loop, fetches a real page and persists a sourced report', async () => {
    const { taskId, executionId } = await seedTask();
    const executor = new Executor({ db: harness.db.db, env: workerEnv(), boss: bossStub, workerId: 'test-worker' });
    await executor.handle(executionId);

    const execution = await harness.db.pool.query('select status, report, usage, error, duration_ms from executions where id = $1', [executionId]);
    const row = execution.rows[0];
    expect(row.status, row.error).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.report.markdown).toContain('Findings');
    expect(row.report.sources.length).toBeGreaterThan(0);
    expect(row.report.sources[0].url).toMatch(/^https:\/\//);
    expect(row.usage.totalTokens).toBeGreaterThan(0);

    const steps = await harness.db.pool.query('select tool, ok from execution_steps where execution_id = $1 order by step', [executionId]);
    expect(steps.rows.length).toBeGreaterThanOrEqual(2);
    expect(steps.rows.map((step) => step.tool)).toContain('search_web');
    expect(steps.rows.map((step) => step.tool)).toContain('open_url');
    expect(steps.rows.every((step) => step.ok)).toBe(true);

    const sources = await harness.db.pool.query('select url, confidence from execution_sources where execution_id = $1', [executionId]);
    expect(sources.rows.length).toBeGreaterThan(0);
    expect(sources.rows[0].confidence).toBe('verified');

    const task = await harness.db.pool.query('select last_run_at from tasks where id = $1', [taskId]);
    expect(task.rows[0].last_run_at).not.toBeNull();
  }, 120_000);

  it('visits three distinct public pages and persists every one as a source', async () => {
    const search = await startFakeSearch();
    const multiPageMock = await createMockOpenAiServer({ researchSteps: 4 });
    try {
      const { executionId, taskId } = await seedTask({
        limits: { maxDurationSec: 120, maxAgentSteps: 6, maxPageVisits: 3, maxOutputBytes: 100000, maxToolCalls: 8, maxSearchQueries: 2 },
      });
      await harness.db.pool.query(
        `update providers set config = jsonb_set(jsonb_set(config, '{baseUrl}', to_jsonb($2::text)), '{models}', '[{"id":"mock-researcher","supportsTools":true}]'::jsonb)
         where id = (select provider_id from tasks where id = $1)`,
        [taskId, multiPageMock.url],
      );
      await harness.db.pool.query(
        `update system_settings set values = jsonb_set(jsonb_set(values, '{searchProvider}', '"searxng"'), '{searchBaseUrl}', to_jsonb($1::text)) where id = 1`,
        [search.url],
      );

      const executor = new Executor({
        db: harness.db.db,
        env: { ...workerEnv(), SEARXNG_URL: search.url },
        boss: bossStub,
        workerId: 'test-worker',
      });
      await executor.handle(executionId);

      const execution = await harness.db.pool.query('select status, error, report from executions where id = $1', [executionId]);
      expect(execution.rows[0].status, execution.rows[0].error).toBe('completed');
      const sources = await harness.db.pool.query('select distinct url from execution_sources where execution_id = $1', [executionId]);
      expect(sources.rows.length).toBeGreaterThanOrEqual(3);
      const opened = await harness.db.pool.query(`select count(*)::int as count from execution_steps where execution_id = $1 and tool = 'open_url' and ok = true`, [executionId]);
      expect(opened.rows[0].count).toBeGreaterThanOrEqual(3);
      expect(execution.rows[0].report.markdown).toContain('example.');
    } finally {
      await multiPageMock.close();
      await search.close();
    }
  }, 180_000);

  it('records a failed execution when the provider is unreachable', async () => {
    const { executionId, taskId } = await seedTask();
    await harness.db.pool.query(
      `update providers set config = jsonb_set(config, '{baseUrl}', '"http://127.0.0.1:9/v1"') where id = (select provider_id from tasks where id = $1)`,
      [taskId],
    );
    const executor = new Executor({ db: harness.db.db, env: workerEnv(), boss: bossStub, workerId: 'test-worker' });
    await executor.handle(executionId);
    const execution = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
    // Transient provider errors are retried first (attempt incremented), then failed.
    expect(['failed', 'queued']).toContain(execution.rows[0].status);
    expect(execution.rows[0].error).toBeTruthy();
  }, 120_000);

  it('blocks a loopback URL from the agent even when the model asks for it', async () => {
    const hostile = await createMockOpenAiServer({ researchSteps: 2, openUrl: `http://127.0.0.1:${RUNNER_PORT}/healthz` });
    try {
      const { executionId, taskId } = await seedTask();
      await harness.db.pool.query(
        `update providers set config = jsonb_set(config, '{baseUrl}', to_jsonb($2::text)) where id = (select provider_id from tasks where id = $1)`,
        [taskId, hostile.url],
      );
      const executor = new Executor({ db: harness.db.db, env: workerEnv(), boss: bossStub, workerId: 'test-worker' });
      await executor.handle(executionId);

      const all = await harness.db.pool.query(`select tool, ok, error from execution_steps where execution_id = $1`, [executionId]);
      const state = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
      const steps = await harness.db.pool.query(`select tool, ok, error, result_preview from execution_steps where execution_id = $1 and tool = 'open_url'`, [executionId]);
      expect(steps.rows, JSON.stringify({ state: state.rows[0], steps: all.rows })).toHaveLength(1);
      expect(steps.rows[0].ok).toBe(false);
      expect(steps.rows[0].error).toMatch(/port|blocked|private|loopback|not public|not allowed/i);
      const execution = await harness.db.pool.query('select status from executions where id = $1', [executionId]);
      expect(execution.rows[0].status).toBe('completed');
    } finally {
      await hostile.close();
    }
  }, 120_000);
});
