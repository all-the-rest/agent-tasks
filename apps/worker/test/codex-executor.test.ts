import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executions, memories, providerCredentials, providers, recommendations } from '@agent-tasks/database';
import { SecretBox } from '@agent-tasks/ai-providers';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import { Executor } from '../src/executor.js';
import type { WorkerEnv } from '../src/env.js';

// Keep the real AgentCancelledError (the executor branches on it) but replace runAgent so
// the test can inspect the adapter context without spawning `codex`.
const state = vi.hoisted(() => ({ options: null as unknown as RunAgentOptions | null }));
vi.mock('@agent-tasks/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-tasks/agent-runtime')>();
  return {
    ...actual,
    runAgent: async (options: RunAgentOptions) => {
      state.options = options;
      return { markdown: '# done', summary: 'done', sources: [], uncertainty: [], steps: [], usage: {}, emailBlocks: [], memoryOps: [], recommendationOps: [], stopReason: 'completed' };
    },
  };
});

const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));

interface FakeInput {
  execution: Record<string, unknown>;
  task: Record<string, unknown>;
  provider: Record<string, unknown>;
  credentials: Array<{ ownerId: string | null; ciphertext: string }>;
}

function fakeDb(input: FakeInput) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const dialect = new PgDialect();

  const chain = (value: unknown) => {
    const builder: Record<string, unknown> = {};
    builder.innerJoin = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = async () => value;
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
    return builder;
  };

  const select = () => ({
    from(table: unknown) {
      if (table === providers) return chain([input.provider]);
      if (table === executions) return chain([{ execution: input.execution, task: input.task }]);
      if (table === providerCredentials) return chain(input.credentials);
      if (table === memories || table === recommendations) return chain([]);
      throw new Error('unexpected select table');
    },
  });

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push({ table, values });
      },
    }),
  });

  const execute = async (query: unknown) => {
    // `loadSettings` passes a plain string; everything else is a drizzle SQL object.
    const sql = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
    if (sql.includes('update executions') && sql.includes("set status = 'running'")) return { rows: [{ id: input.execution.id }] };
    if (sql.includes('from system_settings')) return { rows: [{ values: {} }] };
    if (sql.includes('select cancel_requested')) return { rows: [{ cancel_requested: false }] };
    if (sql.includes('count(*)::int as count')) return { rows: [{ count: 0 }] };
    throw new Error(`unexpected SQL: ${sql}`);
  };

  return { db: { select, update, execute } as never, updates };
}

function workerEnv(codexHomeRoot: string, isolatedRunner = true): WorkerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    RUNNER_URL: 'http://127.0.0.1:1',
    RUNNER_TOKEN: 'unit-test-runner-token',
    WORKER_CONCURRENCY: 1,
    CODEX_HOME_ROOT: codexHomeRoot,
    CODEX_ISOLATED_RUNNER: isolatedRunner ? '1' : '0',
    LOG_LEVEL: 'silent',
  };
}

/** Better Auth ids are 32-character opaque strings, not UUIDs. */
const OWNER = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const homeSegment = (ownerId: string): string => createHash('sha256').update(ownerId, 'utf8').digest('hex');

function codexFixture(ownerId: string) {
  const executionId = randomUUID();
  return {
    executionId,
    input: {
      execution: { id: executionId, ownerId, attempt: 0 },
      task: {
        id: randomUUID(),
        providerId: randomUUID(),
        ownerId,
        title: 'Codex task',
        prompt: 'Say hi',
        systemInstructions: null,
        timezone: 'Europe/Vienna',
        model: 'gpt-5-codex',
        allowWebResearch: false,
        limits: { maxDurationSec: 30, maxAgentSteps: 3, maxPageVisits: 1, maxOutputBytes: 10_000, maxToolCalls: 1, maxSearchQueries: 1 },
      },
      provider: {
        id: randomUUID(),
        name: 'Codex',
        kind: 'codex',
        enabled: true,
        config: { enabled: true, codexHome: '/shared/global-codex', models: [{ id: 'gpt-5-codex' }] },
      },
      credentials: [{ ownerId: null, ciphertext: box.encrypt('shared-codex-key') }],
    } satisfies FakeInput,
  };
}

describe('executor Codex home', () => {
  it('passes the owner-scoped Codex home to the adapter and creates it owner-only when isolation is opted in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tasks-codex-'));
    try {
      const { executionId, input } = codexFixture(OWNER);
      const executor = new Executor({ db: fakeDb(input).db, env: workerEnv(root), boss: {} as never, workerId: 'unit-worker' });
      await executor.handle(executionId);

      expect(state.options?.provider.kind).toBe('codex');
      expect(state.options?.providerContext.config.codexHome).toBe(join(root, homeSegment(OWNER)));
      const info = await stat(join(root, homeSegment(OWNER)));
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables memory tools for a model declared as non-tool-capable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tasks-codex-'));
    try {
      state.options = null;
      const { executionId, input } = codexFixture(OWNER);
      const provider = {
        ...input.provider,
        name: 'Non-tool OpenAI',
        kind: 'openai-compatible',
        config: {
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'gpt-5-codex', supportsTools: false }],
        },
      };
      const executor = new Executor({
        db: fakeDb({ ...input, provider }).db,
        env: workerEnv(root),
        boss: {} as never,
        workerId: 'unit-worker',
      });
      await executor.handle(executionId);

      expect(state.options?.memoryEnabled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses Codex without CODEX_ISOLATED_RUNNER=1 and fails terminally (no retry)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tasks-codex-'));
    try {
      state.options = null;
      const { executionId, input } = codexFixture(OWNER);
      const fake = fakeDb(input);
      const send = vi.fn();
      const executor = new Executor({ db: fake.db, env: workerEnv(root, false), boss: { send } as never, workerId: 'unit-worker' });
      await executor.handle(executionId);

      // Never reaches the adapter, never creates a home directory.
      expect(state.options).toBeNull();
      await expect(stat(join(root, homeSegment(OWNER)))).rejects.toThrow();
      const failed = fake.updates.find((entry) => entry.table === executions && entry.values.status === 'failed');
      expect(failed?.values.error).toMatch(/isolated runner/i);
      expect(failed?.values.error).toMatch(/CODEX_ISOLATED_RUNNER/);
      // `unsupported` is terminal: no queued/retry update and no pg-boss send.
      expect(fake.updates.some((entry) => entry.table === executions && entry.values.status === 'queued')).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('safely encodes a traversal-shaped owner id instead of using it as a path segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tasks-codex-'));
    try {
      state.options = null;
      const ownerId = '../escape';
      const { executionId, input } = codexFixture(ownerId);
      const executor = new Executor({ db: fakeDb(input).db, env: workerEnv(root), boss: {} as never, workerId: 'unit-worker' });
      await executor.handle(executionId);

      const expected = join(root, homeSegment(ownerId));
      expect(state.options?.providerContext.config.codexHome).toBe(expected);
      const info = await stat(expected);
      expect(info.isDirectory()).toBe(true);
      // Nothing was created outside the root.
      await expect(stat(join(root, '..', 'escape'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
