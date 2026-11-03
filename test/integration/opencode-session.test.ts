import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@agent-tasks/database';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { OpenCodeSessionStore } from '../../apps/worker/src/opencode-session-store';
import { OpenCodeV2Client } from '../../apps/worker/src/opencode-v2-client';
import { createOpenCodeV2Runner } from '../../apps/worker/src/opencode-v2-runner';
import { TEST_DATABASE_URL } from '../helpers/harness';

const database = createDatabase(TEST_DATABASE_URL);
const ownerId = randomUUID();
const taskId = randomUUID();
const executionId = randomUUID();
const providerId = randomUUID();
const lease = { ownerId, executionId, workerId: 'opencode-worker-one' };

beforeAll(async () => {
  await database.pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'Owner',$2,true,'USER')`, [ownerId, `${ownerId}@example.invalid`]);
  await database.pool.query(`insert into providers (id, name, kind, enabled, is_default, config) values ($1,$2,'openai-compatible',true,false,'{}')`, [providerId, `test-${providerId}`]);
  await database.pool.query(`insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification) values ($1,$2,'Task','Test',$3,'model',true,$4,'UTC',$5,false,'none')`, [taskId, ownerId, providerId, JSON.stringify({ preset: 'daily', timezone: 'UTC', hour: 6, minute: 0 }), JSON.stringify(AGENT_RUNTIME_LIMITS)]);
  await database.pool.query(`insert into executions (id, task_id, owner_id, task_title, status, trigger, worker_id, lease_expires_at) values ($1,$2,$3,'Task','running','manual',$4,now() + interval '2 minutes')`, [executionId, taskId, ownerId, lease.workerId]);
});

afterAll(async () => {
  await database.pool.query('delete from "user" where id = $1', [ownerId]);
  await database.pool.query('delete from providers where id = $1', [providerId]);
  await database.close();
});

describe('OpenCode execution session recovery', () => {
  it('creates and stores a session before dispatch, then reuses it after worker recovery', async () => {
    const id = randomUUID();
    const firstLease = { ...lease, executionId: id };
    await database.pool.query(`insert into executions (id, task_id, owner_id, task_title, status, trigger, worker_id, lease_expires_at) values ($1,$2,$3,'Task','running','manual',$4,now() + interval '2 minutes')`, [id, taskId, ownerId, lease.workerId]);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = (url as URL).pathname;
      if (path === '/api/session') return new Response(JSON.stringify({ data: { id: 'ses_new' } }));
      if (path.endsWith('/prompt')) {
        const mapping = await new OpenCodeSessionStore(database.db).access(firstLease);
        expect(mapping).toMatchObject({ sessionId: 'ses_new', promptDispatched: true });
        return new Response('{}');
      }
      return new Response(JSON.stringify({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Answer' }] }] }));
    });
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'test', fetch: fetchMock });
    const runner = createOpenCodeV2Runner({ client, directory: '/isolated', model: { providerID: 'test', id: 'model' }, store: new OpenCodeSessionStore(database.db) });
    const options = { model: 'model', prompt: 'Test', limits: AGENT_RUNTIME_LIMITS } as RunAgentOptions;
    expect((await runner(options, firstLease)).markdown).toBe('Answer');
    await database.pool.query(`update executions set worker_id = 'opencode-worker-two' where id = $1`, [id]);
    expect((await runner(options, { ...firstLease, workerId: 'opencode-worker-two' })).markdown).toBe('Answer');
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).pathname)).toEqual([
      '/api/session', '/api/session/ses_new/prompt', '/api/session/ses_new/message', '/api/session/ses_new/message',
    ]);
  });

  it('persists one mapping and one prompt claim, restricted to owner and active lease', async () => {
    const store = new OpenCodeSessionStore(database.db);
    const candidate = { sessionId: 'ses_test', messageId: 'msg_test', promptDispatched: false };
    await expect(store.access({ ...lease, ownerId: 'other-owner' })).rejects.toThrow('lease unavailable');
    await expect(store.access({ ...lease, workerId: 'other-worker' })).rejects.toThrow('lease unavailable');
    expect(await store.access(lease)).toBeNull();
    expect(await store.access(lease, candidate)).toEqual(candidate);
    expect(await store.access(lease, { ...candidate, sessionId: 'ses_other' })).toEqual(candidate);
    const claims = await Promise.all([store.claimPrompt(lease), store.claimPrompt(lease)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await database.pool.query(`update executions set worker_id = 'opencode-worker-two' where id = $1`, [executionId]);
    await expect(store.access(lease)).rejects.toThrow('lease unavailable');
    const recovered = { ...lease, workerId: 'opencode-worker-two' };
    expect(await store.access(recovered)).toEqual({ ...candidate, promptDispatched: true });
    expect(await store.claimPrompt(recovered)).toBe(false);
    await database.pool.query(`update executions set lease_expires_at = now() - interval '1 second' where id = $1`, [executionId]);
    await expect(store.claimPrompt(recovered)).rejects.toThrow('lease unavailable');
  });

  it('resynchronizes the existing session without sending a second prompt', async () => {
    await database.pool.query(`update executions set lease_expires_at = now() + interval '2 minutes' where id = $1`, [executionId]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Recovered answer' }] }] })));
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'test', fetch: fetchMock });
    const runner = createOpenCodeV2Runner({ client, directory: '/isolated', model: { providerID: 'test', id: 'model' }, store: new OpenCodeSessionStore(database.db) });
    const options = { model: 'model', prompt: 'Test', limits: AGENT_RUNTIME_LIMITS } as RunAgentOptions;
    const result = await runner(options, { ...lease, workerId: 'opencode-worker-two' });
    expect(result.markdown).toBe('Recovered answer');
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).pathname)).toEqual(['/api/session/ses_test/message']);
  });
});
