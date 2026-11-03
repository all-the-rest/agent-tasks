import { randomUUID } from 'node:crypto';
import { createDatabase, runMigrations } from '@agent-tasks/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  bootstrapAdmin,
  createHarness,
  inviteAndAccept,
} from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let admin: { cookie: string; id: string };
let other: { cookie: string; id: string };
let providerId: string;
let taskA: string;
let taskB: string;

async function createProvider(): Promise<string> {
  const provider = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: admin.cookie },
    payload: {
      name: `Memory provider ${randomUUID()}`,
      kind: 'openai-compatible',
      config: { baseUrl: 'http://mock:8080/v1', models: [{ id: 'mock-researcher', supportsTools: true }] },
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const id = provider.json().id as string;
  const credential = await harness.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${id}/credentials`,
    headers: { cookie: admin.cookie },
    payload: { apiKey: 'memory-integration-key-123' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  return id;
}

async function createTask(cookie: string, title: string): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie },
    payload: {
      title,
      prompt: 'Research the topic and cite every source in the final report.',
      providerId,
      model: 'mock-researcher',
      enabled: false,
      schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
      limits: { maxDurationSec: 120, maxAgentSteps: 6, maxPageVisits: 4, maxOutputBytes: 100_000, maxToolCalls: 10, maxSearchQueries: 3 },
      allowWebResearch: false,
      notification: 'none',
      memorySettings: { mode: 'auto', contextBytes: 12_000 },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

async function createMemory(cookie: string, payload: Record<string, unknown>): Promise<{ id: string; revision: number; scope: string; content: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/memory',
    headers: { cookie },
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function command(cookie: string, input: string, extra: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/memory/commands',
    headers: { cookie },
    payload: { input, ...extra },
  });
}

beforeAll(async () => {
  harness = await createHarness();
  admin = await bootstrapAdmin(harness, 'admin@example.com', 'admin-password-123');
  other = await inviteAndAccept(harness, admin.cookie, 'other@example.com', 'other-password-123');
  providerId = await createProvider();
  taskA = await createTask(admin.cookie, 'Memory task A');
  taskB = await createTask(admin.cookie, 'Memory task B');
});

afterAll(async () => {
  await harness.close();
});

describe('persistent memory API', () => {
  it('creates, lists, updates and revises a global memory across sessions', async () => {
    const created = await createMemory(admin.cookie, {
      scope: 'global',
      category: 'instruction',
      content: 'Prefer concise reports with a short executive summary.',
      semanticKey: 'report.style',
    });
    expect(created).toMatchObject({ scope: 'global', revision: 1, content: expect.stringContaining('concise') });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/memory/${created.id}`,
      headers: { cookie: admin.cookie },
      payload: { content: 'Prefer concise reports and always include a one-paragraph executive summary.' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ id: created.id, revision: 2 });
    const revisions = await harness.app.inject({
      method: 'GET',
      url: `/api/memory/${created.id}/revisions`,
      headers: { cookie: admin.cookie },
    });
    expect(revisions.statusCode, revisions.body).toBe(200);
    expect(revisions.json().map((revision: { revision: number }) => revision.revision)).toEqual([2, 1]);
    expect(revisions.json()[0].content).toContain('executive summary');

    // A new login is a fresh session; the memory is server state, not chat state.
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const list = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global&q=executive', headers: { cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ id: created.id, revision: 2 });
    expect(list.json().items[0].content).not.toContain('short executive summary');
  });

  it('isolates global memory between users and never leaks ids', async () => {
    const mine = await createMemory(admin.cookie, {
      scope: 'global',
      category: 'preference',
      content: 'My private preference is metric units only.',
    });
    const list = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global&q=metric', headers: { cookie: other.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(0);

    const read = await harness.app.inject({ method: 'GET', url: `/api/memory/${mine.id}`, headers: { cookie: other.cookie } });
    expect(read.statusCode).toBe(404);
    const patch = await harness.app.inject({
      method: 'PATCH',
      url: `/api/memory/${mine.id}`,
      headers: { cookie: other.cookie },
      payload: { content: 'stolen' },
    });
    expect(patch.statusCode).toBe(404);
    const remove = await harness.app.inject({ method: 'DELETE', url: `/api/memory/${mine.id}`, headers: { cookie: other.cookie } });
    expect(remove.statusCode).toBe(404);
  });

  it('isolates task memory between tasks and owners', async () => {
    const a = await createMemory(admin.cookie, {
      scope: 'task',
      taskId: taskA,
      category: 'finding',
      content: 'Task A finding: source alpha reports 42 units.',
    });
    const taskAList = await harness.app.inject({
      method: 'GET',
      url: `/api/memory?scope=task&taskId=${taskA}`,
      headers: { cookie: admin.cookie },
    });
    expect(taskAList.json().items.map((item: { id: string }) => item.id)).toContain(a.id);

    const taskBList = await harness.app.inject({
      method: 'GET',
      url: `/api/memory?scope=task&taskId=${taskB}`,
      headers: { cookie: admin.cookie },
    });
    expect(taskBList.json().items).toHaveLength(0);

    const crossOwner = await harness.app.inject({
      method: 'GET',
      url: `/api/memory?scope=task&taskId=${taskA}`,
      headers: { cookie: other.cookie },
    });
    expect(crossOwner.statusCode).toBe(404);

    const allTaskMemories = await harness.app.inject({
      method: 'GET',
      url: '/api/memory?scope=task',
      headers: { cookie: admin.cookie },
    });
    expect(allTaskMemories.statusCode, allTaskMemories.body).toBe(200);
    expect(allTaskMemories.json().items.some((item: { id: string }) => item.id === a.id)).toBe(true);
    expect(allTaskMemories.json().items.every((item: { scope: string }) => item.scope === 'task')).toBe(true);
  });

  it('parses slash commands on the server and rejects task commands without a task', async () => {
    const learned = await command(admin.cookie, '/learn global Always cite primary sources.');
    expect(learned.statusCode, learned.body).toBe(200);
    expect(learned.json()).toMatchObject({ kind: 'learned', memory: { scope: 'global' } });

    const taskLearned = await command(admin.cookie, '/learn task Remember that report 7 changed its price.', { taskId: taskA });
    expect(taskLearned.statusCode, taskLearned.body).toBe(200);
    expect(taskLearned.json()).toMatchObject({ kind: 'learned', memory: { scope: 'task', taskId: taskA } });

    const missingTask = await command(admin.cookie, '/learn task This must fail.');
    expect(missingTask.statusCode).toBe(400);
    expect(missingTask.json().error.message).toMatch(/No task is selected/i);

    const memoryTask = await command(admin.cookie, '/memory task');
    expect(memoryTask.statusCode).toBe(400);

    const memoryList = await command(admin.cookie, '/memory', { taskId: taskA });
    expect(memoryList.statusCode, memoryList.body).toBe(200);
    expect(memoryList.json()).toMatchObject({ kind: 'memory_list', scope: 'all' });
    expect(memoryList.json().task.some((item: { content: string }) => item.content.includes('report 7'))).toBe(true);
  });

  it('detects duplicates on /learn and replaces content through /update instead of duplicating', async () => {
    await command(admin.cookie, '/learn Duplicate detection prefers short reports.');
    const before = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global', headers: { cookie: admin.cookie } });
    const duplicate = await command(admin.cookie, '/learn Duplicate detection prefers short reports.');
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json().kind).toBe('duplicate');
    const after = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global', headers: { cookie: admin.cookie } });
    expect(after.json().total).toBe(before.json().total);

    const target = duplicate.json().candidates[0] as { id: string };
    const updated = await command(admin.cookie, `/update ${target.id} Duplicate detection now prefers very short reports with tables.`);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ kind: 'updated', memory: { id: target.id, revision: 2 } });
    const list = await harness.app.inject({ method: 'GET', url: `/api/memory?scope=global&q=very short`, headers: { cookie: admin.cookie } });
    expect(list.json().items.some((item: { id: string }) => item.id === target.id)).toBe(true);
  });

  it('refuses an ambiguous update prefix and updates only the exact selected id', async () => {
    // Fixed ids make the shared prefix deterministic; creating through the API
    // would generate random UUIDs and make this test flaky.
    const sharedPrefix = 'a11ce5';
    const firstId = `${sharedPrefix}aa-1111-4111-8111-111111111111`;
    const secondId = `${sharedPrefix}bb-2222-4222-8222-222222222222`;
    await harness.db.pool.query(
      `insert into memories (id, owner_id, scope, category, content, origin, revision)
       values ($1, $2, 'global', 'fact', 'Ambiguous update target one.', 'user', 1),
              ($3, $2, 'global', 'fact', 'Ambiguous update target two.', 'user', 1)`,
      [firstId, admin.id, secondId],
    );

    const ambiguous = await command(admin.cookie, `/update ${sharedPrefix} This text must not replace either memory.`);
    expect(ambiguous.statusCode, ambiguous.body).toBe(200);
    expect(ambiguous.json()).toMatchObject({ kind: 'ambiguous' });
    const candidateIds = (ambiguous.json().candidates as Array<{ id: string }>).map((item) => item.id).sort();
    expect(candidateIds).toEqual([firstId, secondId].sort());

    const unchanged = await harness.db.pool.query(
      'select id, content, revision from memories where id = any($1::uuid[]) order by id',
      [[firstId, secondId]],
    );
    expect(unchanged.rows.map((row: { content: string; revision: number }) => [row.content, row.revision])).toEqual([
      ['Ambiguous update target one.', 1],
      ['Ambiguous update target two.', 1],
    ]);

    const ambiguousForget = await command(admin.cookie, '/forget Ambiguous update target');
    expect(ambiguousForget.statusCode, ambiguousForget.body).toBe(200);
    expect(ambiguousForget.json()).toMatchObject({ kind: 'forget_candidates' });
    expect(ambiguousForget.json().candidates).toHaveLength(2);
    const stillBoth = await harness.db.pool.query('select count(*)::int as count from memories where id = any($1::uuid[])', [[firstId, secondId]]);
    expect(stillBoth.rows[0].count).toBe(2);

    const exact = await command(admin.cookie, `/update ${firstId} Exact memory updated once.`);
    expect(exact.statusCode, exact.body).toBe(200);
    expect(exact.json()).toMatchObject({ kind: 'updated', memory: { id: firstId, revision: 2, content: 'Exact memory updated once.' } });
    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/memory/${secondId}`,
      headers: { cookie: admin.cookie },
    });
    expect(second.json()).toMatchObject({ content: 'Ambiguous update target two.', revision: 1 });

    await harness.db.pool.query('delete from memories where id = any($1::uuid[])', [[firstId, secondId]]);
  });

  it('searches before forgetting, requires confirmation, and removes content from search and export', async () => {
    await command(admin.cookie, '/learn Forget me not unique needle 88231.');
    const search = await command(admin.cookie, '/forget unique needle 88231');
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()).toMatchObject({ kind: 'forget_candidates' });
    const candidate = search.json().candidates[0] as { id: string; scope: string };
    expect(candidate.scope).toBe('global');

    // Still present: search only offers candidates.
    const stillThere = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global&q=88231', headers: { cookie: admin.cookie } });
    expect(stillThere.json().total).toBe(1);

    const preview = await command(admin.cookie, `/forget ${candidate.id}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ kind: 'confirm_forget', memory: { id: candidate.id } });
    const afterPreview = await harness.app.inject({ method: 'GET', url: `/api/memory/${candidate.id}`, headers: { cookie: admin.cookie } });
    expect(afterPreview.statusCode).toBe(200);

    const deleted = await command(admin.cookie, `/forget ${candidate.id}`, { confirm: true });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ kind: 'forgotten', id: candidate.id });

    const gone = await harness.app.inject({ method: 'GET', url: `/api/memory/${candidate.id}`, headers: { cookie: admin.cookie } });
    expect(gone.statusCode).toBe(404);
    const searchAfter = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global&q=88231', headers: { cookie: admin.cookie } });
    expect(searchAfter.json().total).toBe(0);
    const exported = await harness.app.inject({ method: 'GET', url: '/api/memory/export', headers: { cookie: admin.cookie } });
    expect(exported.statusCode).toBe(200);
    expect(JSON.stringify(exported.json().memories)).not.toContain('88231');

    const tombstone = await harness.db.pool.query('select content_hash from memory_tombstones where owner_id = $1', [admin.id]);
    expect(tombstone.rows.length).toBeGreaterThan(0);
    const revisions = await harness.db.pool.query('select count(*)::int as count from memory_revisions where memory_id = $1', [candidate.id]);
    expect(revisions.rows[0].count).toBe(0);
    const changes = await harness.db.pool.query(
      `select before_content, after_content from memory_changes where owner_id = $1 and before_content is not null`,
      [admin.id],
    );
    expect(changes.rows.every((row: { before_content: string | null }) => !String(row.before_content).includes('88231'))).toBe(true);
    const audit = await harness.db.pool.query(`select metadata::text as metadata from audit_logs where action = 'memory.deleted'`);
    expect(audit.rows.every((row: { metadata: string }) => !row.metadata.includes('88231'))).toBe(true);
  });

  it('scopes /forget global and /forget task and rejects a scope mismatch', async () => {
    const global = await createMemory(admin.cookie, {
      scope: 'global',
      category: 'fact',
      content: 'Scoped forget global target.',
    });
    const task = await createMemory(admin.cookie, {
      scope: 'task',
      taskId: taskB,
      category: 'finding',
      content: 'Scoped forget task target.',
    });
    const mismatch = await command(admin.cookie, `/forget task ${global.id}`, { confirm: true });
    expect(mismatch.statusCode).toBe(404);
    const wrongTask = await command(admin.cookie, `/forget global ${task.id}`, { confirm: true });
    expect(wrongTask.statusCode).toBe(404);

    await createMemory(admin.cookie, { scope: 'global', category: 'fact', content: 'Alpha zebra observation 111.' });
    await createMemory(admin.cookie, { scope: 'global', category: 'fact', content: 'Beta zebra observation 222.' });
    const ambiguous = await command(admin.cookie, '/forget zebra observation');
    expect(ambiguous.statusCode, ambiguous.body).toBe(200);
    expect(ambiguous.json()).toMatchObject({ kind: 'forget_candidates' });
    expect(ambiguous.json().candidates.length).toBe(2);
    const stillBoth = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global&q=zebra', headers: { cookie: admin.cookie } });
    expect(stillBoth.json().total).toBe(2);

    const deletedGlobal = await command(admin.cookie, `/forget global ${global.id}`, { confirm: true });
    expect(deletedGlobal.statusCode, deletedGlobal.body).toBe(200);
    const deletedTask = await command(admin.cookie, `/forget task ${task.id}`, { confirm: true });
    expect(deletedTask.statusCode, deletedTask.body).toBe(200);
  });

  it('refuses secrets and invalid scoped content', async () => {
    const fakeApiKey = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
    const secret = await harness.app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { cookie: admin.cookie },
      payload: { scope: 'global', category: 'fact', content: `Deployment key is ${fakeApiKey}` },
    });
    expect(secret.statusCode).toBe(400);
    expect(secret.json().error.message).toMatch(/credential|API key|secret/i);

    const invalidCategory = await harness.app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { cookie: admin.cookie },
      payload: { scope: 'global', category: 'finding', content: 'Findings are task-scoped.' },
    });
    expect(invalidCategory.statusCode).toBe(400);

    const taskWithoutTask = await harness.app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { cookie: admin.cookie },
      payload: { scope: 'task', category: 'finding', content: 'No task attached.' },
    });
    expect(taskWithoutTask.statusCode).toBe(400);
  });

  it('serialises concurrent updates and rejects concurrent duplicate creation', async () => {
    const memory = await createMemory(admin.cookie, {
      scope: 'task',
      taskId: taskA,
      category: 'progress',
      content: 'Concurrent update baseline.',
    });
    const updates = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        harness.app.inject({
          method: 'PATCH',
          url: `/api/memory/${memory.id}`,
          headers: { cookie: admin.cookie },
          payload: { content: `Concurrent update ${index}.` },
        }),
      ),
    );
    expect(updates.every((response) => response.statusCode === 200)).toBe(true);
    const stored = await harness.app.inject({ method: 'GET', url: `/api/memory/${memory.id}`, headers: { cookie: admin.cookie } });
    expect(stored.json().revision).toBe(6);
    expect(stored.json().content).toMatch(/^Concurrent update [0-4]\.$/);

    const createSameKey = () =>
      harness.app.inject({
        method: 'POST',
        url: '/api/memory',
        headers: { cookie: admin.cookie },
        payload: { scope: 'task', taskId: taskB, category: 'finding', content: `Race ${randomUUID()}`, semanticKey: 'race.key' },
      });
    const [first, second] = await Promise.all([createSameKey(), createSameKey()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  });

  it('blocks automatic recreation of a deleted memory from an older revision', async () => {
    const original = 'Revision tombstone finding one.';
    const created = await createMemory(admin.cookie, {
      scope: 'task',
      taskId: taskB,
      category: 'finding',
      content: original,
    });
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/memory/${created.id}`,
      headers: { cookie: admin.cookie },
      payload: { content: 'Revision tombstone finding two.' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/memory/${created.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const tombstones = await harness.db.pool.query('select content_hash from memory_tombstones where task_id = $1', [taskB]);
    expect(tombstones.rows.length).toBeGreaterThanOrEqual(2);

    const execution = await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, provider_id, model)
       values ($1, $2, $3, 'Revision tombstone task', 'completed', 'manual', $4, 'mock-researcher') returning id`,
      [randomUUID(), taskB, admin.id, providerId],
    );
    const { applyTaskLearning } = await import('@agent-tasks/database');
    const result = await applyTaskLearning(harness.db.db, {
      ownerId: admin.id,
      taskId: taskB,
      executionId: execution.rows[0].id as string,
      mode: 'auto',
      memoryOps: [{ operation: 'upsert', category: 'finding', content: original }],
      recommendationOps: [],
    });
    expect(result.skipped.some((item) => item.kind === 'memory' && /tombstone/i.test(item.reason))).toBe(true);
    const recreated = await harness.db.pool.query(
      'select count(*)::int as count from memories where task_id = $1 and content = $2',
      [taskB, original],
    );
    expect(recreated.rows[0].count).toBe(0);
  });

  it('scrubs pending suggestions and their journal rows when a matching memory is deleted', async () => {
    const taskId = await createTask(admin.cookie, 'Pending suggestion scrub task');
    const execution = await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, provider_id, model)
       values ($1, $2, $3, 'Pending suggestion scrub task', 'completed', 'manual', $4, 'mock-researcher') returning id`,
      [randomUUID(), taskId, admin.id, providerId],
    );
    const executionId = execution.rows[0].id as string;
    const { applyTaskLearning } = await import('@agent-tasks/database');
    await applyTaskLearning(harness.db.db, {
      ownerId: admin.id,
      taskId,
      executionId,
      mode: 'suggest',
      memoryOps: [
        { operation: 'upsert', category: 'finding', content: 'Pending same-key leak.', semanticKey: 'pending.same-key' },
        { operation: 'upsert', category: 'finding', content: 'Cross-key leak.', semanticKey: 'pending.other-key' },
      ],
      recommendationOps: [],
    });

    // Create memories that match the pending proposals by key and by content,
    // then forget both. The pending rows have no targetMemoryId.
    const sameKey = await createMemory(admin.cookie, {
      scope: 'task',
      taskId,
      category: 'finding',
      content: 'Pending same-key leak.',
      semanticKey: 'pending.same-key',
    });
    const crossKey = await createMemory(admin.cookie, {
      scope: 'task',
      taskId,
      category: 'finding',
      content: 'Cross-key leak.',
      semanticKey: 'pending.third-key',
    });
    for (const memory of [sameKey, crossKey]) {
      const removed = await harness.app.inject({
        method: 'DELETE',
        url: `/api/memory/${memory.id}`,
        headers: { cookie: admin.cookie },
      });
      expect(removed.statusCode, removed.body).toBe(204);
    }

    const suggestions = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/memory-suggestions`,
      headers: { cookie: admin.cookie },
    });
    expect(suggestions.statusCode, suggestions.body).toBe(200);
    const scrubbed = suggestions.json() as Array<{ content: string; status: string }>;
    expect(scrubbed).toHaveLength(2);
    expect(scrubbed.every((item) => item.content === '[deleted]' && item.status === 'rejected')).toBe(true);

    const changes = await harness.db.pool.query(
      `select before_content, after_content from memory_changes where task_id = $1 and action = 'suggested'`,
      [taskId],
    );
    expect(changes.rows.length).toBeGreaterThanOrEqual(2);
    expect(
      changes.rows.every((row: { before_content: string | null; after_content: string | null }) => row.before_content === null && row.after_content === null),
    ).toBe(true);

    const executionMemory = await harness.app.inject({
      method: 'GET',
      url: `/api/executions/${executionId}/memory`,
      headers: { cookie: admin.cookie },
    });
    expect(executionMemory.statusCode, executionMemory.body).toBe(200);
    expect(JSON.stringify(executionMemory.json())).not.toContain('Pending same-key leak.');
    expect(JSON.stringify(executionMemory.json())).not.toContain('Cross-key leak.');
  });

  it('creates reviewable suggestions and keeps user recommendation decisions authoritative', async () => {
    const taskId = await createTask(admin.cookie, 'Suggestion review task');
    await harness.db.pool.query(
      `insert into system_settings (id, values) values (1, '{}'::jsonb) on conflict (id) do nothing`,
    );
    const execution = await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, provider_id, model)
       values ($1, $2, $3, 'Suggestion review task', 'completed', 'manual', $4, 'mock-researcher') returning id`,
      [randomUUID(), taskId, admin.id, providerId],
    );
    const executionId = execution.rows[0].id as string;
    const { applyTaskLearning } = await import('@agent-tasks/database');
    await applyTaskLearning(harness.db.db, {
      ownerId: admin.id,
      taskId,
      executionId,
      mode: 'suggest',
      memoryOps: [{ operation: 'upsert', category: 'finding', content: 'A proposed finding from a run.', semanticKey: 'finding.one' }],
      recommendationOps: [
        { stableKey: 'offer/one', title: 'Offer one', description: 'First title', sourceUrl: 'https://example.com/one', status: 'recommended' },
      ],
    });
    const suggestions = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/memory-suggestions`,
      headers: { cookie: admin.cookie },
    });
    expect(suggestions.statusCode, suggestions.body).toBe(200);
    expect(suggestions.json().some((item: { status: string }) => item.status === 'pending')).toBe(true);

    const pending = suggestions.json()[0] as { id: string };
    const accepted = await harness.app.inject({
      method: 'POST',
      url: `/api/memory-suggestions/${pending.id}/accept`,
      headers: { cookie: admin.cookie },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().memory).toMatchObject({ taskId, scope: 'task', userEdited: true });

    const recommendations = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/recommendations`,
      headers: { cookie: admin.cookie },
    });
    expect(recommendations.statusCode, recommendations.body).toBe(200);
    const recommendation = recommendations.json()[0] as { id: string; status: string };
    const userStatus = await harness.app.inject({
      method: 'PATCH',
      url: `/api/recommendations/${recommendation.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: 'completed' },
    });
    expect(userStatus.statusCode, userStatus.body).toBe(200);
    // A later automatic observation must not overwrite the user's decision.
    const secondExecution = await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, provider_id, model)
       values ($1, $2, $3, 'Suggestion review task', 'completed', 'schedule', $4, 'mock-researcher') returning id`,
      [randomUUID(), taskId, admin.id, providerId],
    );
    await applyTaskLearning(harness.db.db, {
      ownerId: admin.id,
      taskId,
      executionId: secondExecution.rows[0].id as string,
      mode: 'auto',
      memoryOps: [],
      recommendationOps: [
        { stableKey: 'offer/one', title: 'Offer one renamed', description: 'Changed description', sourceUrl: 'https://example.com/one', status: 'recommended' },
      ],
    });
    const after = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/recommendations`,
      headers: { cookie: admin.cookie },
    });
    expect(after.json()[0]).toMatchObject({ id: recommendation.id, status: 'completed', title: 'Offer one renamed' });

    // Deleting a memory created by accepting a new-memory suggestion must also
    // scrub the suggestion row and its `memoryId = null` journal entry.
    const memoryId = accepted.json().memory.id as string;
    const removal = await harness.app.inject({
      method: 'DELETE',
      url: `/api/memory/${memoryId}`,
      headers: { cookie: admin.cookie },
    });
    expect(removal.statusCode, removal.body).toBe(204);
    const scrubbedSuggestions = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/memory-suggestions`,
      headers: { cookie: admin.cookie },
    });
    const reviewed = (scrubbedSuggestions.json() as Array<{ id: string; content: string; status: string }>).find(
      (item) => item.id === pending.id,
    );
    expect(reviewed).toMatchObject({ status: 'rejected', content: '[deleted]' });
    const scrubbedChanges = await harness.db.pool.query(
      'select before_content, after_content from memory_changes where suggestion_id = $1',
      [pending.id],
    );
    expect(scrubbedChanges.rows.length).toBeGreaterThan(0);
    expect(
      scrubbedChanges.rows.every((row: { before_content: string | null; after_content: string | null }) => row.before_content === null && row.after_content === null),
    ).toBe(true);
    const executionMemory = await harness.app.inject({
      method: 'GET',
      url: `/api/executions/${executionId}/memory`,
      headers: { cookie: admin.cookie },
    });
    expect(executionMemory.statusCode, executionMemory.body).toBe(200);
    expect(JSON.stringify(executionMemory.json())).not.toContain('A proposed finding from a run.');
    const events = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/recommendation-events`,
      headers: { cookie: admin.cookie },
    });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json().some((event: { action: string; changes: { previousTitle?: string } }) => event.action === 'changed' && event.changes.previousTitle === 'Offer one')).toBe(true);
  });

  it('deletes all memories in one confirmed scope without touching the other scope', async () => {
    const taskId = await createTask(admin.cookie, 'Delete-all scope task');
    await createMemory(admin.cookie, { scope: 'global', category: 'fact', content: 'Delete-all global sentinel.' });
    await createMemory(admin.cookie, { scope: 'task', taskId, category: 'finding', content: 'Delete-all task sentinel.' });
    const confirmation = await harness.app.inject({
      method: 'POST',
      url: '/api/memory/delete-all',
      headers: { cookie: admin.cookie },
      payload: { scope: 'global' },
    });
    expect(confirmation.statusCode).toBe(400);
    const deleted = await harness.app.inject({
      method: 'POST',
      url: '/api/memory/delete-all',
      headers: { cookie: admin.cookie },
      payload: { scope: 'global', confirm: true },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().deleted).toBeGreaterThan(0);
    const global = await harness.app.inject({ method: 'GET', url: '/api/memory?scope=global', headers: { cookie: admin.cookie } });
    expect(global.json().total).toBe(0);
    const taskList = await harness.app.inject({ method: 'GET', url: `/api/memory?scope=task&taskId=${taskId}`, headers: { cookie: admin.cookie } });
    expect(taskList.json().items.some((item: { content: string }) => item.content.includes('Delete-all task sentinel'))).toBe(true);
  });

  it('removes task memory and recommendations when the task is deleted (with the API confirmation path)', async () => {
    const taskId = await createTask(admin.cookie, 'Cascade task');
    await createMemory(admin.cookie, {
      scope: 'task',
      taskId,
      category: 'next_action',
      content: 'Cascade me.',
    });
    await harness.db.pool.query(
      `insert into recommendations (id, owner_id, task_id, semantic_key, title, description, status)
       values ($1, $2, $3, 'cascade-key', 'Cascade recommendation', 'Delete with its task.', 'recommended')`,
      [randomUUID(), admin.id, taskId],
    );
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const memories = await harness.db.pool.query('select count(*)::int as count from memories where task_id = $1', [taskId]);
    const recommendations = await harness.db.pool.query('select count(*)::int as count from recommendations where task_id = $1', [taskId]);
    expect(memories.rows[0].count).toBe(0);
    expect(recommendations.rows[0].count).toBe(0);
  });

  it('keeps migrations idempotent and persists memory across a fresh database connection', async () => {
    await runMigrations(TEST_DATABASE_URL);
    const created = await createMemory(admin.cookie, {
      scope: 'global',
      category: 'fact',
      content: 'Restart persistence sentinel.',
    });
    const handle = createDatabase(TEST_DATABASE_URL, { max: 1 });
    try {
      const rows = await handle.pool.query('select content, revision from memories where id = $1', [created.id]);
      expect(rows.rows[0]).toMatchObject({ content: 'Restart persistence sentinel.', revision: 1 });
    } finally {
      await handle.close();
    }
  });
});
