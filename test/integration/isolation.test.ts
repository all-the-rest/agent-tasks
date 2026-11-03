import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, bootstrapAdmin, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let providerId: string;
let aliceTaskId: string;

beforeAll(async () => {
  harness = await createHarness();
  const admin = await bootstrapAdmin(harness);
  adminCookie = admin.cookie;
  aliceCookie = (await inviteAndAccept(harness, adminCookie, 'alice@example.com')).cookie;
  bobCookie = (await inviteAndAccept(harness, adminCookie, 'bob@example.com')).cookie;

  const provider = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: { name: 'Local mock', kind: 'openai-compatible', config: { baseUrl: 'http://mock:8080/v1', models: [{ id: 'mock-researcher', supportsTools: true }] } },
  });
  expect(provider.statusCode).toBe(201);
  providerId = provider.json().id;
  const credential = await harness.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${providerId}/credentials`,
    headers: { cookie: adminCookie },
    payload: { apiKey: 'shared-mock-key' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
});

afterAll(async () => {
  await harness.close();
});

const taskPayload = () => ({
  title: 'Alice research task',
  prompt: 'Research the current state of public transport in Vienna and cite sources.',
  providerId,
  model: 'mock-researcher',
  enabled: true,
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  limits: { maxDurationSec: 120, maxAgentSteps: 6, maxPageVisits: 4, maxOutputBytes: 100000, maxToolCalls: 10, maxSearchQueries: 3 },
  allowWebResearch: true,
  notification: 'none',
});

describe('multi-user isolation', () => {
  it('lets each user create a task and hides it from the other', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: aliceCookie }, payload: taskPayload() });
    expect(created.statusCode, created.body).toBe(201);
    aliceTaskId = created.json().id;

    const aliceList = await harness.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: aliceCookie } });
    expect(aliceList.json()).toHaveLength(1);

    const bobList = await harness.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(0);

    const bobRead = await harness.app.inject({ method: 'GET', url: `/api/tasks/${aliceTaskId}`, headers: { cookie: bobCookie } });
    expect(bobRead.statusCode).toBe(404);

    const bobWrite = await harness.app.inject({ method: 'PATCH', url: `/api/tasks/${aliceTaskId}`, headers: { cookie: bobCookie }, payload: { title: 'hijacked' } });
    expect(bobWrite.statusCode).toBe(404);

    const bobDelete = await harness.app.inject({ method: 'DELETE', url: `/api/tasks/${aliceTaskId}`, headers: { cookie: bobCookie } });
    expect(bobDelete.statusCode).toBe(404);

    const bobRun = await harness.app.inject({ method: 'POST', url: `/api/tasks/${aliceTaskId}/run`, headers: { cookie: bobCookie } });
    expect(bobRun.statusCode).toBe(404);

    const bobPause = await harness.app.inject({ method: 'POST', url: `/api/tasks/${aliceTaskId}/pause`, headers: { cookie: bobCookie } });
    expect(bobPause.statusCode).toBe(404);
  });

  it('hides executions and their artifacts across users', async () => {
    const run = await harness.app.inject({ method: 'POST', url: `/api/tasks/${aliceTaskId}/run`, headers: { cookie: aliceCookie } });
    expect(run.statusCode, run.body).toBe(200);
    const executionId = run.json().executionId as string;

    const bobRead = await harness.app.inject({ method: 'GET', url: `/api/executions/${executionId}`, headers: { cookie: bobCookie } });
    expect(bobRead.statusCode).toBe(404);

    const bobCancel = await harness.app.inject({ method: 'POST', url: `/api/executions/${executionId}/cancel`, headers: { cookie: bobCookie } });
    expect(bobCancel.statusCode).toBe(404);

    const bobExport = await harness.app.inject({ method: 'GET', url: `/api/executions/${executionId}/export?format=md`, headers: { cookie: bobCookie } });
    expect(bobExport.statusCode).toBe(404);

    const bobHistory = await harness.app.inject({ method: 'GET', url: `/api/tasks/${aliceTaskId}/executions`, headers: { cookie: bobCookie } });
    expect(bobHistory.statusCode).toBe(404);

    const aliceRead = await harness.app.inject({ method: 'GET', url: `/api/executions/${executionId}`, headers: { cookie: aliceCookie } });
    expect(aliceRead.statusCode).toBe(200);
    expect(aliceRead.json().ownerId).not.toBe(undefined);
  });

  it('exports the full execution record as JSON and Markdown', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: aliceCookie }, payload: { ...taskPayload(), title: 'Export task' } });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;
    const owner = await harness.db.pool.query('select owner_id from tasks where id = $1', [taskId]);
    const executionId = randomUUID();
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, trigger, provider_id, model, started_at, finished_at, duration_ms, report, usage)
       values ($1,$2,$3,'Export task','completed','manual',$4,'mock-researcher',now(),now(),1500,$5,$6)`,
      [
        executionId,
        taskId,
        owner.rows[0].owner_id,
        providerId,
        JSON.stringify({
          summary: 'Short answer',
          markdown: 'Long body',
          sources: [{ url: 'https://example.com/', title: 'Example', confidence: 'verified', retrievedAt: '2026-11-03T00:00:00.000Z' }],
          uncertainty: ['Only one source was available'],
        }),
        JSON.stringify({ totalTokens: 42 }),
      ],
    );
    await harness.db.pool.query(
      `insert into execution_steps (id, execution_id, step, tool, args, ok, started_at, finished_at, duration_ms, result_preview)
       values ($1,$2,1,'search_web','{}',true,now(),now(),10,'two results')`,
      [randomUUID(), executionId],
    );

    // The JSON export must carry the timeline and failure detail, not only the text.
    const json = await harness.app.inject({ method: 'GET', url: `/api/executions/${executionId}/export?format=json`, headers: { cookie: aliceCookie } });
    expect(json.statusCode, json.body).toBe(200);
    expect(String(json.headers['content-disposition'])).toContain('.json');
    const body = json.json();
    expect(body.durationMs).toBe(1500);
    expect(body.steps.map((step: { tool: string }) => step.tool)).toEqual(['search_web']);
    expect(body.report.uncertainty).toHaveLength(1);
    expect(body.usage.totalTokens).toBe(42);

    // The Markdown export must include the summary and the uncertainty section.
    const md = await harness.app.inject({ method: 'GET', url: `/api/executions/${executionId}/export?format=md`, headers: { cookie: aliceCookie } });
    expect(md.statusCode, md.body).toBe(200);
    expect(String(md.headers['content-disposition'])).toContain('.md');
    expect(md.body).toContain('## Summary');
    expect(md.body).toContain('Short answer');
    expect(md.body).toContain('## Uncertainty');
    expect(md.body).toContain('Only one source was available');
    expect(md.body).toContain('https://example.com/');
  });

  it('does not give an administrator implicit access to user tasks', async () => {
    const adminRead = await harness.app.inject({ method: 'GET', url: `/api/tasks/${aliceTaskId}`, headers: { cookie: adminCookie } });
    expect(adminRead.statusCode).toBe(404);
    const adminExecutions = await harness.app.inject({ method: 'GET', url: '/api/executions', headers: { cookie: adminCookie } });
    expect(adminExecutions.json()).toHaveLength(0);
  });

  it('keeps personal provider credentials private', async () => {
    const aliceCredential = await harness.app.inject({
      method: 'POST',
      url: `/api/providers/${providerId}/credentials`,
      headers: { cookie: aliceCookie },
      payload: { apiKey: 'alice-secret-key', label: 'alice' },
    });
    expect(aliceCredential.statusCode).toBe(201);

    const providers = await harness.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: bobCookie } });
    const local = providers.json().find((provider: { id: string }) => provider.id === providerId);
    expect(local.hasPersonalCredential).toBe(false);

    const rows = await harness.db.pool.query('select owner_id, ciphertext from provider_credentials');
    for (const row of rows.rows) {
      expect(String(row.ciphertext)).not.toContain('alice-secret-key');
      expect(String(row.ciphertext).startsWith('v1.')).toBe(true);
    }

    // Bob deleting "his" credential must not touch Alice's row.
    await harness.app.inject({ method: 'DELETE', url: `/api/providers/${providerId}/credentials`, headers: { cookie: bobCookie } });
    const after = await harness.db.pool.query('select owner_id from provider_credentials');
    expect(after.rows.some((row) => row.owner_id !== null)).toBe(true);
  });

  it('forbids user-role access to admin endpoints', async () => {
    for (const url of ['/api/admin/users', '/api/admin/settings', '/api/admin/audit', '/api/admin/providers', '/api/admin/metrics']) {
      const response = await harness.app.inject({ method: 'GET', url, headers: { cookie: aliceCookie } });
      expect(response.statusCode).toBe(403);
    }
    const invite = await harness.app.inject({ method: 'POST', url: '/api/admin/invitations', headers: { cookie: bobCookie }, payload: { email: 'x@example.com' } });
    expect(invite.statusCode).toBe(403);
    const settings = await harness.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: bobCookie }, payload: {} });
    expect(settings.statusCode).toBe(403);
  });

  it('ignores a user id supplied by the client', async () => {
    const alice = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: aliceCookie } });
    const bob = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: bobCookie } });
    const forged = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: bobCookie },
      payload: { ...taskPayload(), ownerId: alice.json().user.id, id: randomUUID() },
    });
    expect(forged.statusCode).toBe(201);
    const stored = await harness.db.pool.query('select owner_id from tasks where id = $1', [forged.json().id]);
    expect(stored.rows[0]?.owner_id).toBe(bob.json().user.id);
    expect(stored.rows[0]?.owner_id).not.toBe(alice.json().user.id);
  });

  it('prevents an admin from demoting the last administrator', async () => {
    const admin = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: adminCookie } });
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.json().user.id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'USER' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a token from a revoked invitation', async () => {
    const invite = await harness.app.inject({ method: 'POST', url: '/api/admin/invitations', headers: { cookie: adminCookie }, payload: { email: 'carol@example.com' } });
    const token = invite.json().token as string;
    const revoke = await harness.app.inject({ method: 'DELETE', url: `/api/admin/invitations/${invite.json().id}`, headers: { cookie: adminCookie } });
    expect(revoke.statusCode).toBe(204);
    const accept = await harness.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, name: 'Carol', password: 'carol-password-123' } });
    expect(accept.statusCode).toBe(404);
  });
});
