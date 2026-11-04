import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;
let sourceProviderId: string;
let adopterProviderId: string;
let uncredentialedProviderId: string;

const sourcePrompt =
  'Research the current state of public transport in Vienna and cite the sources you opened.';

async function createProvider(
  current: TestHarness,
  cookie: string,
  name: string,
  model: string,
  withCredential = true,
): Promise<string> {
  const provider = await current.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie },
    payload: {
      name,
      kind: 'openai-compatible',
      config: { baseUrl: 'http://mock:8080/v1', models: [{ id: model, supportsTools: true }] },
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const providerId = provider.json().id as string;
  if (withCredential) {
    const credential = await current.app.inject({
      method: 'POST',
      url: `/api/admin/providers/${providerId}/credentials`,
      headers: { cookie },
      payload: { apiKey: `share-test-key-${name}` },
    });
    expect(credential.statusCode, credential.body).toBe(201);
  }
  return providerId;
}

async function createSourceTask(title = 'Vienna transit monitor'): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie: aliceCookie },
    payload: {
      title,
      description: 'PRIVATE DESCRIPTION',
      prompt: sourcePrompt,
      systemInstructions: 'SECRET SYSTEM INSTRUCTIONS',
      providerId: sourceProviderId,
      model: 'source-model',
      enabled: true,
      schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
      allowWebResearch: true,
      notification: 'email',
      memorySettings: { mode: 'off', contextBytes: 5_000 },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

async function shareTask(taskId: string): Promise<{ id: string; token: string; url: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/share`,
    headers: { cookie: aliceCookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

/**
 * Waits until at least one backend is blocked by `blockerPid`. The test holds
 * the conflicting advisory lock itself, so this observes request progress
 * without a sleep that has to be long enough to win a race.
 */
async function observeBlockedBy(client: PoolClient, blockerPid: number, timeoutMs = 3_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let blocked: number[] = [];
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(
      `select pid
         from pg_stat_activity
        where datname = current_database()
          and pid <> $1
          and pg_blocking_pids(pid) @> array[$1]::int[]`,
      [blockerPid],
    );
    blocked = result.rows.map((row) => row.pid);
    if (blocked.length > 0) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return blocked;
}

beforeAll(async () => {
  harness = await createHarness();
  const admin = await bootstrapAdmin(harness);
  adminCookie = admin.cookie;
  const alice = await inviteAndAccept(harness, adminCookie, 'alice@example.com');
  const bob = await inviteAndAccept(harness, adminCookie, 'bob@example.com');
  aliceCookie = alice.cookie;
  aliceId = alice.id;
  bobCookie = bob.cookie;
  bobId = bob.id;
  sourceProviderId = await createProvider(harness, adminCookie, 'Share source provider', 'source-model');
  adopterProviderId = await createProvider(harness, adminCookie, 'Share adopter provider', 'adopter-model');
  uncredentialedProviderId = await createProvider(
    harness,
    adminCookie,
    'Share uncredentialed provider',
    'no-key-model',
    false,
  );
});

afterAll(async () => {
  await harness.close();
});

describe('task share snapshots', () => {
  it('publishes only the frozen definition and stores the token hashed', async () => {
    const taskId = await createSourceTask();
    const memory = await harness.app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: { cookie: aliceCookie },
      payload: { scope: 'task', taskId, category: 'fact', content: 'TOP SECRET MEMORY' },
    });
    expect(memory.statusCode, memory.body).toBe(201);
    await harness.db.pool.query(
      `insert into executions (id, task_id, owner_id, task_title, status, "trigger", error)
       values (gen_random_uuid(), $1, $2, 'Vienna transit monitor', 'completed', 'manual', 'TOP SECRET HISTORY')`,
      [taskId, aliceId],
    );

    const share = await shareTask(taskId);
    expect(share.token).toHaveLength(43);
    expect(share.url).toBe(`http://localhost:5173/share/${share.token}`);

    const stored = await harness.db.pool.query<{ token_hash: string; snapshot: unknown }>(
      'select token_hash, snapshot from task_shares where id = $1',
      [share.id],
    );
    expect(stored.rows[0].token_hash).toBe(createHash('sha256').update(share.token).digest('hex'));
    expect(stored.rows[0].token_hash).not.toContain(share.token);
    expect(stored.rows[0].snapshot).toEqual({
      title: 'Vienna transit monitor',
      prompt: sourcePrompt,
      schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
      timezone: 'Europe/Vienna',
    });

    const publicRead = await harness.app.inject({ method: 'GET', url: `/api/shares/${share.token}` });
    expect(publicRead.statusCode, publicRead.body).toBe(200);
    expect(publicRead.headers['cache-control']).toBe('no-store');
    expect(publicRead.headers['referrer-policy']).toBe('no-referrer');
    expect(publicRead.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(publicRead.json()).toEqual({
      title: 'Vienna transit monitor',
      prompt: sourcePrompt,
      schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
      timezone: 'Europe/Vienna',
    });
    const serialized = JSON.stringify(publicRead.json());
    expect(Object.keys(publicRead.json()).sort()).toEqual(['prompt', 'schedule', 'timezone', 'title']);
    for (const excluded of [
      'PRIVATE DESCRIPTION',
      'SECRET SYSTEM INSTRUCTIONS',
      'TOP SECRET MEMORY',
      'TOP SECRET HISTORY',
      'source-model',
      sourceProviderId,
      aliceId,
      taskId,
      'share-test-key',
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it('scopes create, list and revoke to the task owner', async () => {
    const taskId = await createSourceTask('Owned share task');
    const share = await shareTask(taskId);

    const bobCreate = await harness.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/share`,
      headers: { cookie: bobCookie },
    });
    expect(bobCreate.statusCode).toBe(404);
    const bobList = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/shares`,
      headers: { cookie: bobCookie },
    });
    expect(bobList.statusCode).toBe(404);
    const bobRevoke = await harness.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/shares/${share.id}`,
      headers: { cookie: bobCookie },
    });
    expect(bobRevoke.statusCode).toBe(404);
    expect(
      (await harness.app.inject({ method: 'GET', url: `/api/shares/${share.token}` })).statusCode,
    ).toBe(200);

    const aliceList = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/shares`,
      headers: { cookie: aliceCookie },
    });
    expect(aliceList.statusCode, aliceList.body).toBe(200);
    expect(aliceList.json()).toEqual([
      expect.objectContaining({ id: share.id, revokedAt: null }),
    ]);
    expect(JSON.stringify(aliceList.json())).not.toContain(share.token);

    const revoke = await harness.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/shares/${share.id}`,
      headers: { cookie: aliceCookie },
    });
    expect(revoke.statusCode, revoke.body).toBe(204);
    const revokedRead = await harness.app.inject({ method: 'GET', url: `/api/shares/${share.token}` });
    expect(revokedRead.statusCode).toBe(404);
    expect(revokedRead.headers['cache-control']).toBe('no-store');
    expect(revokedRead.headers['referrer-policy']).toBe('no-referrer');
    const revokedAdopt = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      headers: { cookie: bobCookie },
      payload: { providerId: adopterProviderId, model: 'adopter-model' },
    });
    expect(revokedAdopt.statusCode).toBe(404);
    const secondRevoke = await harness.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/shares/${share.id}`,
      headers: { cookie: aliceCookie },
    });
    expect(secondRevoke.statusCode).toBe(404);
  });

  it('adopts a copy only for an authenticated user with a usable provider', async () => {
    const taskId = await createSourceTask('Adoption source task');
    const share = await shareTask(taskId);

    const anonymous = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      payload: { providerId: adopterProviderId, model: 'adopter-model' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(anonymous.headers['referrer-policy']).toBe('no-referrer');

    const smuggled = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      headers: { cookie: bobCookie },
      payload: {
        providerId: adopterProviderId,
        model: 'adopter-model',
        prompt: 'Injected prompt that must not be used',
        ownerId: aliceId,
      },
    });
    expect(smuggled.statusCode).toBe(400);

    const unusable = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      headers: { cookie: bobCookie },
      payload: { providerId: uncredentialedProviderId, model: 'no-key-model' },
    });
    expect(unusable.statusCode).toBe(400);

    const unknownModel = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      headers: { cookie: bobCookie },
      payload: { providerId: adopterProviderId, model: 'not-in-catalog' },
    });
    expect(unknownModel.statusCode).toBe(400);

    const adopted = await harness.app.inject({
      method: 'POST',
      url: `/api/shares/${share.token}/adopt`,
      headers: { cookie: bobCookie },
      payload: { providerId: adopterProviderId, model: 'adopter-model' },
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    const copy = adopted.json();
    expect(copy).toMatchObject({
      ownerId: bobId,
      title: 'Adoption source task',
      prompt: sourcePrompt,
      providerId: adopterProviderId,
      model: 'adopter-model',
      enabled: true,
      timezone: 'Europe/Vienna',
      description: null,
      systemInstructions: null,
      allowWebResearch: true,
      notification: 'none',
    });
    expect(copy.schedule).toEqual({ preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 });
    expect(copy.id).not.toBe(taskId);
    expect(copy.nextRunAt).toBeTruthy();
    expect(copy).not.toHaveProperty('limits');

    const newTaskMemory = await harness.db.pool.query(
      'select count(*)::int as count from memories where task_id = $1',
      [copy.id],
    );
    expect(newTaskMemory.rows[0].count).toBe(0);
    const newTaskExecutions = await harness.db.pool.query(
      'select count(*)::int as count from executions where task_id = $1',
      [copy.id],
    );
    expect(newTaskExecutions.rows[0].count).toBe(0);

    // The copy is independent: revoking the link leaves it intact.
    const revoke = await harness.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/shares/${share.id}`,
      headers: { cookie: aliceCookie },
    });
    expect(revoke.statusCode).toBe(204);
    const stillThere = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${copy.id}`,
      headers: { cookie: bobCookie },
    });
    expect(stillThere.statusCode, stillThere.body).toBe(200);
    const aliceCannotSeeCopy = await harness.app.inject({
      method: 'GET',
      url: `/api/tasks/${copy.id}`,
      headers: { cookie: aliceCookie },
    });
    expect(aliceCannotSeeCopy.statusCode).toBe(404);
  });

  it('serialises revocation against an adoption that already read the share', async () => {
    const taskId = await createSourceTask('Race source task');
    const share = await shareTask(taskId);

    // A trigger pauses task inserts on an advisory lock held by the test. The
    // session lock is released automatically with the connection, so a crashed
    // test cannot leave later inserts hanging.
    const lockA = 918_273;
    const lockB = 645;
    const functionName = 'task_share_race_pause';
    const blocker = await harness.db.pool.connect();
    let adoptRequest: ReturnType<TestHarness['app']['inject']> | undefined;
    let revokeRequest: ReturnType<TestHarness['app']['inject']> | undefined;
    let adoptBlocked: number[] = [];
    let revokeWaited: number[] = [];
    let triggerInstalled = false;
    try {
      await harness.db.pool.query(`drop trigger if exists ${functionName} on tasks`);
      await harness.db.pool.query(
        `create or replace function ${functionName}() returns trigger language plpgsql as $$
           begin
             perform pg_advisory_xact_lock(${lockA}, ${lockB});
             return new;
           end
         $$`,
      );
      await harness.db.pool.query(
        `create trigger ${functionName} before insert on tasks for each row execute function ${functionName}()`,
      );
      triggerInstalled = true;
      await blocker.query(`select pg_advisory_lock(${lockA}, ${lockB})`);
      const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      adoptRequest = harness.app.inject({
        method: 'POST',
        url: `/api/shares/${share.token}/adopt`,
        headers: { cookie: bobCookie },
        payload: { providerId: adopterProviderId, model: 'adopter-model' },
      });
      // The adoption has read the share and is now paused in its insert.
      adoptBlocked = await observeBlockedBy(blocker, blockerPid);
      if (adoptBlocked.length > 0) {
        revokeRequest = harness.app.inject({
          method: 'DELETE',
          url: `/api/tasks/${taskId}/shares/${share.id}`,
          headers: { cookie: aliceCookie },
        });
        // The adoption holds the share row lock; the revocation has to wait on
        // it instead of completing first.
        revokeWaited = await observeBlockedBy(blocker, adoptBlocked[0]!);
      }
    } finally {
      await blocker.query(`select pg_advisory_unlock(${lockA}, ${lockB})`).catch(() => {});
      blocker.release();
      if (triggerInstalled) {
        await harness.db.pool.query(`drop trigger if exists ${functionName} on tasks`);
        await harness.db.pool.query(`drop function if exists ${functionName}()`);
      }
    }

    const adopted = await adoptRequest!;
    const revoked = revokeRequest ? await revokeRequest : null;
    expect(adoptBlocked.length).toBeGreaterThan(0);
    // Without the share-row lock the revocation completes while the adoption is
    // still paused, so the copy is created after DELETE already answered 204.
    expect(revokeWaited.length).toBeGreaterThan(0);
    expect(adopted.statusCode, adopted.body).toBe(201);
    expect(revoked?.statusCode).toBe(204);
  });

  it('rejects malformed and unknown share tokens without leaking detail', async () => {
    for (const token of ['not-a-token', 'A'.repeat(43), 'x'.repeat(80)]) {
      const read = await harness.app.inject({ method: 'GET', url: `/api/shares/${encodeURIComponent(token)}` });
      expect(read.statusCode).toBe(404);
      expect(read.json()).toEqual({ error: { code: 'not_found', message: 'share not found' } });
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.headers['referrer-policy']).toBe('no-referrer');
      expect(read.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    // Router-level length limits reject an oversized path before any lookup.
    const oversized = await harness.app.inject({ method: 'GET', url: `/api/shares/${'x'.repeat(150)}` });
    expect(oversized.statusCode).toBe(414);
  });
});
