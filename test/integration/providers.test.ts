import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, bootstrapAdmin, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;
let adminCookie: string;
let aliceCookie: string;
let providerId: string;

const SECRET_HEADER = 'Bearer sk-secret-header-value';

beforeAll(async () => {
  harness = await createHarness();
  adminCookie = (await bootstrapAdmin(harness)).cookie;
  aliceCookie = (await inviteAndAccept(harness, adminCookie, 'alice@example.com')).cookie;

  const provider = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: {
      name: 'Route test provider',
      kind: 'openai-compatible',
      config: {
        baseUrl: 'http://mock:8080/v1',
        headers: { authorization: SECRET_HEADER, 'x-api-key': 'sk-second-secret' },
        userAgent: 'agent-tasks-test/1.0',
        models: [{ id: 'mock-researcher', supportsTools: true }],
      },
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  providerId = provider.json().id;
});

afterAll(async () => {
  await harness.close();
});

describe('provider routes', () => {
  it('answers 404 for a malformed provider id instead of a database error', async () => {
    const cases: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; cookie: string; payload?: Record<string, unknown> }> = [
      { method: 'PATCH', url: '/api/admin/providers/not-a-uuid', cookie: adminCookie, payload: { name: 'renamed' } },
      { method: 'DELETE', url: '/api/admin/providers/not-a-uuid', cookie: adminCookie },
      { method: 'POST', url: '/api/admin/providers/not-a-uuid/credentials', cookie: adminCookie, payload: { apiKey: 'shared-secret-key' } },
      { method: 'DELETE', url: '/api/admin/providers/not-a-uuid/credentials', cookie: adminCookie },
      { method: 'POST', url: '/api/admin/providers/not-a-uuid/models/refresh', cookie: adminCookie },
      { method: 'POST', url: '/api/admin/providers/not-a-uuid/health', cookie: adminCookie },
      { method: 'POST', url: '/api/providers/not-a-uuid/credentials', cookie: aliceCookie, payload: { apiKey: 'personal-secret-key' } },
      { method: 'DELETE', url: '/api/providers/not-a-uuid/credentials', cookie: aliceCookie },
    ];

    for (const route of cases) {
      const response = await harness.app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: route.cookie },
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}: ${response.body}`).toBe(404);
    }
  });

  it('answers 404 when the provider id is well formed but unknown', async () => {
    const missing = randomUUID();
    const cases: Array<{ method: 'POST' | 'DELETE'; url: string; cookie: string; payload?: Record<string, unknown> }> = [
      { method: 'POST', url: `/api/admin/providers/${missing}/credentials`, cookie: adminCookie, payload: { apiKey: 'shared-secret-key' } },
      { method: 'DELETE', url: `/api/admin/providers/${missing}/credentials`, cookie: adminCookie },
      { method: 'POST', url: `/api/admin/providers/${missing}/models/refresh`, cookie: adminCookie },
      { method: 'POST', url: `/api/admin/providers/${missing}/health`, cookie: adminCookie },
      { method: 'POST', url: `/api/providers/${missing}/credentials`, cookie: aliceCookie, payload: { apiKey: 'personal-secret-key' } },
      { method: 'DELETE', url: `/api/providers/${missing}/credentials`, cookie: aliceCookie },
    ];

    for (const route of cases) {
      const response = await harness.app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: route.cookie },
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}: ${response.body}`).toBe(404);
    }
  });

  it('never echoes provider header secrets in an admin response', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Secret header provider',
        kind: 'openai-compatible',
        config: { baseUrl: 'http://mock:8080/v1', headers: { authorization: 'Bearer sk-created-secret' } },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain('sk-created-secret');
    expect(created.body).not.toContain('Bearer');

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${created.json().id}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Secret header provider renamed' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.body).not.toContain('sk-created-secret');
    expect(patched.body).not.toContain('Bearer');

    const list = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(SECRET_HEADER);
    expect(list.body).not.toContain('sk-second-secret');
    expect(list.body).not.toContain('Bearer');

    const provider = list.json().find((row: { id: string }) => row.id === providerId);
    expect(provider.config.baseUrl).toBe('http://mock:8080/v1');
    expect(provider.config.headers).toEqual({ authorization: '***', 'x-api-key': '***' });
  });

  it('answers 400 for an invalid provider config on create and patch', async () => {
    const missingCodexHome = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: { name: 'Broken codex', kind: 'codex', config: { enabled: true } },
    });
    expect(missingCodexHome.statusCode, missingCodexHome.body).toBe(400);
    expect(missingCodexHome.json().error.code).toBe('bad_request');

    const badBaseUrl = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: { name: 'Broken endpoint', kind: 'openai-compatible', config: { baseUrl: 'not-a-url' } },
    });
    expect(badBaseUrl.statusCode, badBaseUrl.body).toBe(400);

    const patch = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      headers: { cookie: adminCookie },
      payload: { config: { baseUrl: 'not-a-url' } },
    });
    expect(patch.statusCode, patch.body).toBe(400);
    expect(patch.json().error.code).toBe('bad_request');
  });

  it('preserves the stored header secret when the redacted config is patched back', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Header round-trip provider',
        kind: 'openai-compatible',
        config: { baseUrl: 'http://mock:8080/v1', headers: { authorization: 'Bearer secret' } },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    const adminList = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
    const redacted = adminList.json().find((row: { id: string }) => row.id === id);
    expect(redacted.config.headers).toEqual({ authorization: '***' });

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Header round-trip provider renamed', config: redacted.config },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.body).not.toContain('Bearer secret');

    const stored = await harness.db.pool.query<{ config: { headers?: Record<string, string> } }>(
      'select config from providers where id = $1',
      [id],
    );
    expect(stored.rows[0]?.config.headers).toEqual({ authorization: 'Bearer secret' });
  });

  it('updates a shared credential instead of inserting a duplicate', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/providers/${providerId}/credentials`,
      headers: { cookie: adminCookie },
      payload: { apiKey: 'shared-key-version-one' },
    });
    expect(first.statusCode, first.body).toBe(201);

    const before = await harness.db.pool.query(
      'select id, ciphertext from provider_credentials where provider_id = $1 and owner_id is null and label = $2',
      [providerId, 'default'],
    );

    const second = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/providers/${providerId}/credentials`,
      headers: { cookie: adminCookie },
      payload: { apiKey: 'shared-key-version-two' },
    });
    expect(second.statusCode, second.body).toBe(201);

    const after = await harness.db.pool.query(
      'select count(*)::int as count, min(ciphertext) as ciphertext from provider_credentials where provider_id = $1 and owner_id is null and label = $2',
      [providerId, 'default'],
    );
    expect(after.rows[0].count).toBe(1);
    // The row was updated in place: same id, new ciphertext.
    expect(after.rows[0].ciphertext).not.toBe(before.rows[0].ciphertext);
  });

  it('round-trips a Codex provider configuration without stripping adapter fields', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Codex experimental',
        kind: 'codex',
        enabled: true,
        config: {
          enabled: true,
          codexHome: '/var/lib/agent-tasks/codex/single-tenant',
          models: [{ id: 'codex-mini', label: 'Codex mini', supportsTools: false }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json();
    expect(body.config.codexHome).toBe('/var/lib/agent-tasks/codex/single-tenant');
    expect(body.config.enabled).toBe(true);
    expect(body.config.binary).toBe('codex');
    expect(body.config.models).toEqual([{ id: 'codex-mini', label: 'Codex mini', supportsTools: false }]);

    const list = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
    const stored = list.json().find((row: { id: string }) => row.id === body.id);
    expect(stored.config.codexHome).toBe('/var/lib/agent-tasks/codex/single-tenant');
    expect(stored.config.enabled).toBe(true);
  });
});
