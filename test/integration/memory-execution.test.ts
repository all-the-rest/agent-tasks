import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { SecretBox } from '@agent-tasks/ai-providers';
import { createMockOpenAiServer } from '@agent-tasks/mock-openai';
import type { MockServer } from '@agent-tasks/mock-openai';
import { Executor } from '../../apps/worker/src/executor';
import type { WorkerEnv } from '../../apps/worker/src/env';
import { bootstrapAdmin, createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let mock: MockServer;
let ownerId: string;
let providerId: string;
let taskId: string;
let ownerCookieValue: string;

const MEMORY_TEXT = 'First run finding: alpha price is 42 units.';

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: harness.env.DATABASE_URL,
    SECRETS_ENCRYPTION_KEY: harness.env.SECRETS_ENCRYPTION_KEY,
    RUNNER_URL: 'http://127.0.0.1:9',
    RUNNER_TOKEN: 'memory-execution-runner-token',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    WORKER_CONCURRENCY: 1,
    LOG_LEVEL: 'silent',
  };
}

const bossStub = { send: async () => 'job-id' } as unknown as PgBoss;

async function newExecution(): Promise<string> {
  const id = randomUUID();
  await harness.db.pool.query(
    `insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id)
     values ($1,$2,$3,'Memory research','queued','manual','mock-researcher',$4)`,
    [id, taskId, ownerId, providerId],
  );
  return id;
}

async function run(executionId: string): Promise<void> {
  const executor = new Executor({ db: harness.db.db, env: workerEnv(), boss: bossStub, workerId: 'memory-test-worker' });
  await executor.handle(executionId);
  const row = await harness.db.pool.query('select status, error from executions where id = $1', [executionId]);
  expect(row.rows[0].status, row.rows[0].error).toBe('completed');
}

function systemPrompts(): string[] {
  return mock.requests
    .map((request) => {
      const messages = (request.body?.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [];
      return messages.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n');
    })
    .filter(Boolean);
}

beforeAll(async () => {
  harness = await createHarness();
  const owner = await bootstrapAdmin(harness, `memory-owner-${randomUUID()}@example.com`, 'memory-owner-password-123');
  ownerId = owner.id;
  ownerCookieValue = owner.cookie;
  mock = await createMockOpenAiServer({
    researchSteps: 0,
    requireStableSession: false,
    memoryOps: [{ category: 'finding', content: MEMORY_TEXT, semanticKey: 'finding.alpha-price' }],
    recommendationOps: [
      {
        stableKey: 'offer/alpha',
        title: 'Alpha offer',
        description: 'Costs 42 units at the observed source.',
        sourceUrl: 'https://example.com/alpha',
        status: 'recommended',
        metadata: { price: 42 },
      },
    ],
  });
  providerId = (await harness.db.pool.query(
    `insert into providers (id, name, kind, enabled, is_default, config) values ($1,$2,'openai-compatible',true,true,$3) returning id`,
    [randomUUID(), `Memory mock ${randomUUID()}`, JSON.stringify({ baseUrl: mock.url, models: [{ id: 'mock-researcher', supportsTools: true }] })],
  )).rows[0].id;
  const box = new SecretBox(harness.env.SECRETS_ENCRYPTION_KEY);
  await harness.db.pool.query(
    `insert into provider_credentials (id, provider_id, owner_id, label, ciphertext) values ($1,$2,null,'shared',$3)`,
    [randomUUID(), providerId, box.encrypt('memory-mock-key')],
  );
  await harness.db.pool.query(
    `insert into system_settings (id, values) values (1, $1)
     on conflict (id) do update set values = excluded.values`,
    [JSON.stringify({ searchProvider: 'none', defaultTimezone: 'Europe/Vienna', allowRegistration: false, maxConcurrentExecutionsPerUser: 2, maxTaskExecutionsPerDay: 50, browserAllowHttp: true, browserAllowedPorts: [80, 443] })],
  );

  taskId = randomUUID();
  await harness.db.pool.query(
    `insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification, memory_settings)
     values ($1,$2,'Memory research','Research alpha and report changes. Cite sources.',$3,'mock-researcher',true,$4,'Europe/Vienna',$5,false,'none',$6)`,
    [
      taskId,
      ownerId,
      providerId,
      JSON.stringify({ preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 0 }),
      JSON.stringify({ maxDurationSec: 60, maxAgentSteps: 8, maxPageVisits: 0, maxOutputBytes: 100_000, maxToolCalls: 20, maxSearchQueries: 0 }),
      JSON.stringify({ mode: 'auto', contextBytes: 12_000 }),
    ],
  );
});

afterAll(async () => {
  await mock.close();
  await harness.close();
});

describe('automatic task learning across real executions', () => {
  it('persists structured task memory and recommendations only after success', async () => {
    const executionId = await newExecution();
    await run(executionId);

    const memory = await harness.db.pool.query('select content, semantic_key, origin, user_edited from memories where task_id = $1', [taskId]);
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0]).toMatchObject({ content: MEMORY_TEXT, semantic_key: 'finding.alpha-price', origin: 'agent', user_edited: false });

    const recommendation = await harness.db.pool.query('select status, title, first_execution_id from recommendations where task_id = $1', [taskId]);
    expect(recommendation.rows).toHaveLength(1);
    expect(recommendation.rows[0]).toMatchObject({ status: 'recommended', title: 'Alpha offer', first_execution_id: executionId });

    const global = await harness.db.pool.query('select count(*)::int as count from memories where owner_id = $1 and scope = $2', [ownerId, 'global']);
    expect(global.rows[0].count).toBe(0);

    const steps = await harness.db.pool.query(`select tool, ok from execution_steps where execution_id = $1 order by step`, [executionId]);
    expect(steps.rows.map((step) => step.tool)).toEqual(['record_task_memory', 'track_recommendation']);
    expect(steps.rows.every((step) => step.ok)).toBe(true);

    const changes = await harness.db.pool.query('select action from memory_changes where execution_id = $1', [executionId]);
    expect(changes.rows.some((row: { action: string }) => row.action === 'created')).toBe(true);
  }, 120_000);

  it('injects previous task memory and recommendations into the next execution without duplicating them', async () => {
    const executionId = await newExecution();
    await run(executionId);

    const prompts = systemPrompts();
    const latest = prompts[prompts.length - 1] ?? '';
    expect(latest).toContain('TASK MEMORY');
    expect(latest).toContain(MEMORY_TEXT);
    expect(latest).toContain('PREVIOUS RECOMMENDATIONS');
    expect(latest).toContain('offer/alpha');

    const memories = await harness.db.pool.query('select count(*)::int as count from memories where task_id = $1', [taskId]);
    const recommendations = await harness.db.pool.query('select count(*)::int as count from recommendations where task_id = $1', [taskId]);
    expect(memories.rows[0].count).toBe(1);
    expect(recommendations.rows[0].count).toBe(1);

    const events = await harness.db.pool.query(`select action from recommendation_events where execution_id = $1`, [executionId]);
    expect(events.rows.filter((row: { action: string }) => row.action === 'created')).toHaveLength(0);

    const answer = await harness.db.pool.query('select report from executions where id = $1', [executionId]);
    expect(answer.rows[0].report.markdown).toContain('Previous task memory was provided');
    expect(answer.rows[0].report.markdown).toContain('Existing tracked recommendations were recognized');
  }, 120_000);

  it('never overwrites a user-corrected memory and never restores a deleted memory', async () => {
    const memory = await harness.db.pool.query('select id from memories where task_id = $1', [taskId]);
    const memoryId = memory.rows[0].id as string;

    const corrected = 'User correction: alpha price is 39 units, verified manually.';
    const patch = await harness.app.inject({
      method: 'PATCH',
      url: `/api/memory/${memoryId}`,
      headers: { cookie: ownerCookieValue },
      payload: { content: corrected },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json()).toMatchObject({ revision: 3, userEdited: true });

    await run(await newExecution());
    const afterCorrection = await harness.db.pool.query('select content, user_edited from memories where id = $1', [memoryId]);
    expect(afterCorrection.rows[0]).toMatchObject({ content: corrected, user_edited: true });
    const skipped = await harness.db.pool.query(`select summary from memory_changes where action = 'skipped' order by created_at desc limit 1`);
    expect(skipped.rows[0]?.summary).toMatch(/user-edited|protected/i);
    const promptsAfterCorrection = systemPrompts();
    expect(promptsAfterCorrection[promptsAfterCorrection.length - 1]).toContain(corrected);

    // The user's recommendation decision stays authoritative across automatic runs.
    const recommendation = await harness.db.pool.query('select id from recommendations where task_id = $1', [taskId]);
    const recommendationId = recommendation.rows[0].id as string;
    const status = await harness.app.inject({
      method: 'PATCH',
      url: `/api/recommendations/${recommendationId}`,
      headers: { cookie: ownerCookieValue },
      payload: { status: 'accepted' },
    });
    expect(status.statusCode, status.body).toBe(200);

    const remove = await harness.app.inject({
      method: 'DELETE',
      url: `/api/memory/${memoryId}`,
      headers: { cookie: ownerCookieValue },
    });
    expect(remove.statusCode, remove.body).toBe(204);
    const gone = await harness.db.pool.query('select count(*)::int as count from memories where id = $1', [memoryId]);
    expect(gone.rows[0].count).toBe(0);

    // Two further executions: the tombstone must block the repeated automatic
    // proposal, not only the first run after deletion.
    await run(await newExecution());
    await run(await newExecution());
    const afterDeletion = await harness.db.pool.query('select count(*)::int as count from memories where task_id = $1', [taskId]);
    expect(afterDeletion.rows[0].count).toBe(0);
    const tombstone = await harness.db.pool.query('select content_hash, semantic_key from memory_tombstones where task_id = $1', [taskId]);
    expect(tombstone.rows.length).toBeGreaterThanOrEqual(1);
    expect(tombstone.rows.every((row: { semantic_key: string | null }) => row.semantic_key === 'finding.alpha-price')).toBe(true);
    const blocked = await harness.db.pool.query(`select count(*)::int as count from memory_changes where action = 'skipped' and summary ilike '%tombstone%'`);
    expect(blocked.rows[0].count).toBeGreaterThanOrEqual(2);
    const promptsAfterDeletion = systemPrompts();
    const lastPrompt = promptsAfterDeletion[promptsAfterDeletion.length - 1] ?? '';
    expect(lastPrompt).not.toContain(corrected);
    expect(lastPrompt).not.toContain('alpha price is 42 units');

    // Old execution steps are a separate history. They still record what the model
    // proposed, but nothing reconstructs memory from them after deletion.
    const historical = await harness.db.pool.query(`select args::text as args from execution_steps where tool = 'record_task_memory'`);
    expect(historical.rows.some((row: { args: string }) => row.args.includes('alpha price'))).toBe(true);

    const recommendationAfter = await harness.db.pool.query('select status from recommendations where id = $1', [recommendationId]);
    expect(recommendationAfter.rows[0].status).toBe('accepted');
    const recommendationCount = await harness.db.pool.query('select count(*)::int as count from recommendations where task_id = $1', [taskId]);
    expect(recommendationCount.rows[0].count).toBe(1);

    const audit = await harness.db.pool.query(`select metadata::text as metadata from audit_logs where action = 'memory.deleted'`);
    expect(audit.rows.every((row: { metadata: string }) => !row.metadata.includes('alpha price'))).toBe(true);
  }, 180_000);

  it('does not learn anything when automatic learning is off', async () => {
    const memoryBefore = await harness.db.pool.query('select count(*)::int as count from memories where task_id = $1', [taskId]);
    await harness.db.pool.query(`update tasks set memory_settings = '{"mode":"off","contextBytes":12000}'::jsonb where id = $1`, [taskId]);
    const executionId = await newExecution();
    await run(executionId);
    const steps = await harness.db.pool.query('select tool, ok from execution_steps where execution_id = $1', [executionId]);
    expect(steps.rows.length).toBeGreaterThan(0);
    expect(steps.rows.every((row: { ok: boolean }) => row.ok === false)).toBe(true);
    const memoryAfter = await harness.db.pool.query('select count(*)::int as count from memories where task_id = $1', [taskId]);
    expect(memoryAfter.rows[0].count).toBe(memoryBefore.rows[0].count);
  }, 120_000);
});
