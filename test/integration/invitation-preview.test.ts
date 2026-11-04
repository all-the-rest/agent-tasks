import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let adminCookie: string;

const INVITATION_NOT_FOUND = { error: { code: 'not_found', message: 'invitation not found' } };

function previewUrls(token: string): [string, string] {
  const encoded = encodeURIComponent(token);
  return [`/api/invitations/${encoded}`, `/api/invitations/${encoded}/preview`];
}

async function createInvitation(email: string): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/invitations',
    headers: { cookie: adminCookie },
    payload: { email, role: 'USER' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().token as string;
}

async function previewBoth(token: string) {
  return Promise.all(
    previewUrls(token).map((url) => harness.app.inject({ method: 'GET', url })),
  );
}

/** Both routes must answer a non-usable token exactly like an unknown one. */
async function expectHiddenFromBoth(token: string): Promise<void> {
  const responses = await previewBoth(token);
  for (const response of responses) {
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual(INVITATION_NOT_FOUND);
  }
  expect(responses[0]?.statusCode).toBe(responses[1]?.statusCode);
  expect(responses[0]?.json()).toEqual(responses[1]?.json());
}

beforeAll(async () => {
  harness = await createHarness();
  const admin = await bootstrapAdmin(harness);
  adminCookie = admin.cookie;
});

afterAll(async () => {
  await harness.close();
});

describe('invitation preview state checks', () => {
  it('returns the same metadata from both preview routes for a usable invitation', async () => {
    const token = await createInvitation('valid-preview@example.com');
    const responses = await previewBoth(token);

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        email: 'valid-preview@example.com',
        role: 'USER',
        expiresAt: expect.any(String),
      });
      expect(Object.keys(response.json()).sort()).toEqual(['email', 'expiresAt', 'role']);
    }
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
  });

  it('hides an expired invitation from both preview routes', async () => {
    const token = await createInvitation('expired-preview@example.com');
    await harness.db.pool.query(
      "update invitations set expires_at = now() - interval '1 minute' where email = $1",
      ['expired-preview@example.com'],
    );

    await expectHiddenFromBoth(token);
  });

  it('hides a revoked invitation from both preview routes', async () => {
    const token = await createInvitation('revoked-preview@example.com');
    await harness.db.pool.query(
      'update invitations set revoked_at = now() where email = $1',
      ['revoked-preview@example.com'],
    );

    await expectHiddenFromBoth(token);
  });

  it('hides an accepted invitation from both preview routes', async () => {
    const token = await createInvitation('accepted-preview@example.com');

    const beforeAcceptance = await previewBoth(token);
    for (const response of beforeAcceptance) {
      expect(response.statusCode, response.body).toBe(200);
    }

    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      payload: { token, name: 'Accepted Preview', password: 'accepted-preview-123' },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    await expectHiddenFromBoth(token);
  });

  it('answers an unknown token identically from both preview routes', async () => {
    await expectHiddenFromBoth('unknown-preview-token');
  });
});
