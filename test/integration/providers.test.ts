import { randomUUID } from 'node:crypto';
import { providerModels } from '@agent-tasks/database';
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

  it('strips provider URL userinfo from both admin and user responses, including legacy rows', async () => {
    const original = await harness.db.pool.query<{ config: Record<string, unknown> }>(
      'select config from providers where id = $1',
      [providerId],
    );
    const originalConfig = original.rows[0]?.config;
    expect(originalConfig).toBeDefined();
    const password = 'legacy-url-password-should-not-leak';
    await harness.db.pool.query(
      'update providers set config = $2 where id = $1',
      [providerId, { ...originalConfig, baseUrl: `https://legacy-user:${password}@gateway.example/v1` }],
    );

    try {
      const adminResponse = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
      const adminProvider = adminResponse.json().find((row: { id: string }) => row.id === providerId);
      expect(adminProvider.config.baseUrl).toBe('https://gateway.example/v1');
      expect(adminResponse.body).not.toContain(password);

      const userResponse = await harness.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: aliceCookie } });
      const userProvider = userResponse.json().find((row: { id: string }) => row.id === providerId);
      expect(userProvider.baseUrl).toBe('https://gateway.example/v1');
      expect(userResponse.body).not.toContain(password);
    } finally {
      await harness.db.pool.query('update providers set config = $2 where id = $1', [providerId, originalConfig]);
    }
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

  it('refuses loopback, metadata and plain-http public provider endpoints', async () => {
    const rejected = [
      'http://127.0.0.1:8080/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:8080/v1',
      'http://opencode.ai/inference/go/openai/v1',
      'ftp://opencode.ai/v1',
      'https://user:secret@opencode.ai/v1',
    ];
    for (const baseUrl of rejected) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        headers: { cookie: adminCookie },
        payload: { name: `Rejected ${baseUrl}`, kind: 'openai-compatible', config: { baseUrl } },
      });
      expect(response.statusCode, `${baseUrl}: ${response.body}`).toBe(400);
      expect(response.body).not.toContain('secret');
    }

    // The public Go endpoint and internal single-label services stay valid.
    for (const baseUrl of ['https://opencode.ai/inference/go/openai/v1', 'http://mock:8080/v1']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        headers: { cookie: adminCookie },
        payload: { name: `Accepted ${baseUrl}`, kind: 'openai-compatible', config: { baseUrl } },
      });
      expect(response.statusCode, `${baseUrl}: ${response.body}`).toBe(201);
    }
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

  it('keeps the admin default model and hidden models, and hides them from the task editor', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Catalog policy provider',
        kind: 'openai-compatible',
        config: {
          baseUrl: 'http://mock:8080/v1',
          defaultModel: 'model-b',
          disabledModels: ['model-c'],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json().config.defaultModel).toBe('model-b');
    expect(created.json().config.disabledModels).toEqual(['model-c']);

    // The catalog table is what the task editor sees; disabling lives in config so
    // a later refresh does not lose the administrator's choice.
    await harness.db.pool.query(
      `insert into provider_models (provider_id, model_id, label, supports_tools) values ($1,'model-a','Model A',true), ($1,'model-b','Model B',true), ($1,'model-c','Model C',false)`,
      [id],
    );

    const adminList = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
    const adminView = adminList.json().find((row: { id: string }) => row.id === id);
    expect(adminView.config.defaultModel).toBe('model-b');
    expect(adminView.config.disabledModels).toEqual(['model-c']);

    const userList = await harness.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: aliceCookie } });
    const userView = userList.json().find((row: { id: string }) => row.id === id);
    expect(userView.defaultModel).toBe('model-b');
    expect(userView.models.map((model: { id: string }) => model.id)).toEqual(['model-a', 'model-b']);
  });

  it('records which provider fields changed without their values', async () => {
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${providerId}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Route test provider renamed', enabled: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const audit = await harness.db.pool.query<{ metadata: { fields?: string[] } }>(
      `select metadata from audit_logs where action = 'provider.updated' and target_id = $1 order by created_at desc limit 1`,
      [providerId],
    );
    expect(audit.rows[0]?.metadata.fields).toEqual(['name', 'enabled']);
  });

  it('updates a shared credential instead of inserting a duplicate', async () => {    const first = await harness.app.inject({
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

  it('exposes the discovered model catalog to the admin UI', async () => {
    await harness.context.db
      .insert(providerModels)
      .values({ providerId, modelId: 'discovered-model', label: 'Discovered model', supportsTools: true, contextLength: 128_000 })
      .onConflictDoNothing();

    const list = await harness.app.inject({ method: 'GET', url: '/api/admin/providers', headers: { cookie: adminCookie } });
    expect(list.statusCode, list.body).toBe(200);
    const stored = list.json().find((row: { id: string }) => row.id === providerId);
    expect(stored.models).toContainEqual({
      id: 'discovered-model',
      label: 'Discovered model',
      supportsTools: true,
      contextLength: 128_000,
    });
  });
});
