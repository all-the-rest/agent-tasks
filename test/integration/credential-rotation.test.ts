import { randomUUID } from 'node:crypto';
import { resolveCredential } from '@agent-tasks/ai-providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let adminCookie: string;
let memberId: string;

beforeAll(async () => {
  harness = await createHarness();
  const admin = await bootstrapAdmin(harness);
  adminCookie = admin.cookie;
  const member = await inviteAndAccept(harness, adminCookie, 'rotation@example.com');
  memberId = member.id;
});

afterAll(async () => {
  await harness.close();
});

async function createProvider(name: string): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: { name, kind: 'openai-compatible', config: { baseUrl: 'http://mock:8080/v1' } },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

async function rotateSharedCredential(providerId: string, apiKey: string, label = 'default') {
  return harness.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${providerId}/credentials`,
    headers: { cookie: adminCookie },
    payload: { apiKey, label },
  });
}

/** Reproduces a row written by the old append-on-every-save code path. */
async function insertCredential(input: {
  providerId: string;
  ownerId: string | null;
  label: string;
  apiKey: string;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const at = input.createdAt ?? new Date();
  await harness.db.pool.query(
    `insert into provider_credentials (id, provider_id, owner_id, label, ciphertext, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6)`,
    [id, input.providerId, input.ownerId, input.label, harness.context.secrets.encrypt(input.apiKey), at],
  );
  return id;
}

async function sharedRows(providerId: string): Promise<Array<{ id: string; label: string; ciphertext: string }>> {
  const result = await harness.db.pool.query<{ id: string; label: string; ciphertext: string }>(
    'select id, label, ciphertext from provider_credentials where provider_id = $1 and owner_id is null order by created_at, id',
    [providerId],
  );
  return result.rows;
}

function decrypt(ciphertext: string): string {
  return harness.context.secrets.decrypt(ciphertext);
}

describe('shared provider credential rotation', () => {
  it('removes legacy duplicate rows and makes the rotated key the only resolvable shared credential', async () => {
    const providerId = await createProvider(`Legacy rotation provider ${randomUUID()}`);
    const otherProviderId = await createProvider(`Unrelated rotation provider ${randomUUID()}`);

    // Two same-label duplicates (the old NULL-proof upsert bug) plus a stale row
    // under another label. resolveCredential ignores labels, so all three could be
    // selected before the fix.
    await insertCredential({ providerId, ownerId: null, label: 'default', apiKey: 'legacy-shared-key-one', createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertCredential({ providerId, ownerId: null, label: 'default', apiKey: 'legacy-shared-key-two', createdAt: new Date('2026-01-02T00:00:00Z') });
    await insertCredential({ providerId, ownerId: null, label: 'legacy-label', apiKey: 'legacy-shared-key-three', createdAt: new Date('2026-01-03T00:00:00Z') });

    // Personal credentials and other providers' shared credentials must survive.
    await insertCredential({ providerId, ownerId: memberId, label: 'personal', apiKey: 'member-personal-key' });
    await insertCredential({ providerId: otherProviderId, ownerId: null, label: 'default', apiKey: 'other-provider-key' });

    const rotated = await rotateSharedCredential(providerId, 'rotated-shared-key-value');
    expect(rotated.statusCode, rotated.body).toBe(201);

    const rows = await sharedRows(providerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('default');
    const resolved = resolveCredential([{ ownerId: null, ciphertext: rows[0]!.ciphertext }], 'system', decrypt);
    expect(resolved).toEqual({ apiKey: 'rotated-shared-key-value', shared: true });

    const personal = await harness.db.pool.query<{ ciphertext: string }>(
      'select ciphertext from provider_credentials where provider_id = $1 and owner_id = $2',
      [providerId, memberId],
    );
    expect(personal.rows).toHaveLength(1);
    expect(decrypt(personal.rows[0]!.ciphertext)).toBe('member-personal-key');

    const otherRows = await sharedRows(otherProviderId);
    expect(otherRows).toHaveLength(1);
    expect(decrypt(otherRows[0]!.ciphertext)).toBe('other-provider-key');
  });

  it('serialises concurrent rotations into exactly one live shared credential', async () => {
    const providerId = await createProvider(`Concurrent rotation provider ${randomUUID()}`);
    await insertCredential({ providerId, ownerId: null, label: 'default', apiKey: 'legacy-concurrent-key-one', createdAt: new Date('2026-02-01T00:00:00Z') });
    await insertCredential({ providerId, ownerId: null, label: 'default', apiKey: 'legacy-concurrent-key-two', createdAt: new Date('2026-02-02T00:00:00Z') });

    const keys = Array.from({ length: 6 }, (_, index) => `concurrent-rotation-key-${index}`);
    const responses = await Promise.all(keys.map((key) => rotateSharedCredential(providerId, key)));
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);

    const rows = await sharedRows(providerId);
    expect(rows).toHaveLength(1);
    const liveKey = decrypt(rows[0]!.ciphertext);
    expect(keys).toContain(liveKey);
    expect(liveKey).not.toBe('legacy-concurrent-key-one');
    expect(liveKey).not.toBe('legacy-concurrent-key-two');
  });
});
