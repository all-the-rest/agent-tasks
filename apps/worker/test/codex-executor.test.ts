import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executions, providerCredentials, providerModels, providers, user } from '@agent-tasks/database';
import { SecretBox } from '@agent-tasks/ai-providers';
import type { AgentRunResult, RunAgentOptions } from '@agent-tasks/agent-runtime';
import { Executor } from '../src/executor.js';
import type { WorkerEnv } from '../src/env.js';

const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));
const ownerId = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function fixture(kind = 'codex', notification: 'none' | 'email' = 'none') {
  const executionId = randomUUID();
  const task = {
    id: randomUUID(),
    providerId: randomUUID(),
    ownerId,
    title: 'Provider task',
    prompt: 'Say hi',
    systemInstructions: null,
    timezone: 'Europe/Vienna',
    model: 'mock-model',
    allowWebResearch: false,
    notification,
    memorySettings: { mode: 'off' },
    limits: { maxDurationSec: 30, maxAgentSteps: 3, maxPageVisits: 1, maxOutputBytes: 10_000, maxToolCalls: 1, maxSearchQueries: 1 },
  };
  const provider = {
    id: task.providerId,
    name: 'Test provider',
    kind,
    enabled: true,
    config: { baseUrl: 'https://provider.invalid/v1', models: [{ id: 'mock-model', supportsTools: true }] },
  };
  const execution = { id: executionId, ownerId, attempt: 0 };
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const dialect = new PgDialect();
  const execute = async (query: unknown) => {
    const sql = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
    if (sql.includes('from system_settings')) return { rows: [{ values: {} }] };
    if (sql.includes('select owner_id, attempt')) return { rows: [{ owner_id: ownerId, attempt: 0, already_admitted_today: false }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('prior_executions_today')) return { rows: [{ prior_executions_today: 0, other_running_for_owner: 0 }] };
    if (sql.includes('set status = \'running\'')) return { rows: [] };
    if (sql.includes('select cancel_requested')) return { rows: [{ cancel_requested: false }] };
    if (sql.includes('count(*)::int as count')) return { rows: [{ count: 0 }] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const chain = (value: unknown) => {
    const builder: Record<string, unknown> = {};
    builder.innerJoin = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = async () => value;
    builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
    return builder;
  };
  const db = {
    execute,
    transaction: async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }),
    select: () => ({
      from(table: unknown) {
        if (table === providers) return chain([provider]);
        if (table === executions) return chain([{ execution, task }]);
        if (table === providerCredentials) return chain([{ ownerId: null, ciphertext: box.encrypt('fake-provider-key') }]);
        if (table === providerModels) return chain([]);
        if (table === user) return chain([{ email: 'owner@example.com' }]);
        throw new Error('unexpected select table');
      },
    }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }) }),
    delete: () => ({ where: async () => undefined }),
    insert: () => ({ values: async () => undefined }),
  };
  return { db: db as never, updates, executionId, task, provider };
}

const env: WorkerEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  RUNNER_URL: 'http://127.0.0.1:1',
  RUNNER_TOKEN: 'unit-test-runner-token',
  WORKER_CONCURRENCY: 1,
  OPENCODE_PROVISIONER_URL: 'http://fake-opencode.invalid:4090',
  OPENCODE_PROVISIONER_TOKEN: 'unit-test-fake-provisioner-token-0123456789',
  LOG_LEVEL: 'silent',
};

const result: AgentRunResult = {
  markdown: 'All checks passed.',
  summary: 'All checks passed.',
  sources: [],
  uncertainty: [],
  steps: [],
  usage: {},
  emailBlocks: [
    { type: 'heading', text: 'Weekly report', level: 1 },
    { type: 'paragraph', text: 'Details.' },
    { type: 'button', label: 'Open', url: 'https://example.com/executions/1' },
  ],
  memoryOps: [],
  recommendationOps: [],
  stopReason: 'completed',
};

describe('isolated OpenCode provider contract', () => {
  it.each(['codex', 'ollama', 'openai'])('rejects unsupported %s provider kind without invoking the runner', async (kind) => {
    const fake = fixture(kind);
    const send = vi.fn();
    const openCodeRunner = vi.fn(async () => result);
    const executor = new Executor({ db: fake.db, env, boss: { send } as never, workerId: 'unit-worker', openCodeRunner });

    await executor.handle(fake.executionId);

    expect(openCodeRunner).not.toHaveBeenCalled();
    const failed = fake.updates.find((entry) => entry.table === executions && entry.values.status === 'failed');
    expect(failed?.values.error).toMatch(new RegExp(`provider kind ${kind} is not supported`, 'i'));
    expect(send).not.toHaveBeenCalled();
  });

  it('persists OpenCode report blocks and delivers the same content in completion mail', async () => {
    const fake = fixture('openai-compatible', 'email');
    const openCodeRunner = vi.fn(async (options: RunAgentOptions) => {
      expect(options.provider.kind).toBe('openai-compatible');
      return result;
    });
    const mailer = { send: vi.fn(async () => undefined) };
    const executor = new Executor({
      db: fake.db,
      env: { ...env, PUBLIC_BASE_URL: 'https://tasks.example.com' },
      boss: {} as never,
      workerId: 'unit-worker',
      openCodeRunner,
      mailer,
    });

    await executor.handle(fake.executionId);

    expect(openCodeRunner).toHaveBeenCalledOnce();
    expect(fake.updates.find((entry) => entry.table === executions && entry.values.status === 'completed')?.values.report)
      .toMatchObject({
        markdown: 'All checks passed.',
        summary: 'All checks passed.',
        email: { blocks: result.emailBlocks },
      });
    const mail = mailer.send.mock.calls[0]?.[0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('owner@example.com');
    expect(mail.subject).toBe('Task completed: Provider task');
    expect(mail.html).toContain('Weekly report');
    expect(mail.html).toContain('All checks passed.');
    expect(mail.html).toContain('href="https://example.com/executions/1"');
    expect(mail.text).toContain('Details.');
  });
});
