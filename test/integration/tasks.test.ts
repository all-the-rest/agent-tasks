import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function providerFor(current: TestHarness, adminCookie: string): Promise<string> {
  const provider = await current.app.inject({
    method: 'POST',
    url: '/api/admin/providers',
    headers: { cookie: adminCookie },
    payload: {
      name: 'Partial PATCH provider',
      kind: 'openai-compatible',
      config: { baseUrl: 'http://mock:8080/v1', models: [{ id: 'mock-researcher', supportsTools: true }] },
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const providerId = provider.json().id as string;
  const credential = await current.app.inject({
    method: 'POST',
    url: `/api/admin/providers/${providerId}/credentials`,
    headers: { cookie: adminCookie },
    payload: { apiKey: 'partial-patch-key-123' },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  return providerId;
}

const taskBody = (providerId: string) => ({
  title: 'Paused research task',
  prompt: 'Research the current state of public transport in Vienna and cite sources.',
  providerId,
  model: 'mock-researcher',
  enabled: true,
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  limits: { maxDurationSec: 120, maxAgentSteps: 6, maxPageVisits: 4, maxOutputBytes: 100000, maxToolCalls: 10, maxSearchQueries: 3 },
  allowWebResearch: false,
  notification: 'none',
});

describe('partial task updates', () => {
  it('does not resume a paused task or reset its flags on a title-only PATCH', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const alice = await inviteAndAccept(harness, admin.cookie, 'alice@example.com');
    const providerId = await providerFor(harness, admin.cookie);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: alice.cookie },
      payload: taskBody(providerId),
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().id as string;

    const paused = await harness.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/pause`, headers: { cookie: alice.cookie } });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().enabled).toBe(false);

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
      payload: { title: 'Renamed while paused' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      title: 'Renamed while paused',
      enabled: false,
      allowWebResearch: false,
      notification: 'none',
      nextRunAt: null,
    });

    const stored = await harness.db.pool.query<{ enabled: boolean; allow_web_research: boolean; notification: string; next_run_at: Date | null }>(
      'select enabled, allow_web_research, notification, next_run_at from tasks where id = $1',
      [taskId],
    );
    expect(stored.rows[0]).toMatchObject({ enabled: false, allow_web_research: false, notification: 'none', next_run_at: null });
  });

  it('keeps timezone and locale when only the theme is patched', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: { cookie: admin.cookie },
      payload: { timezone: 'America/New_York', locale: 'de' },
    });
    expect(first.statusCode, first.body).toBe(204);

    const theme = await harness.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: { cookie: admin.cookie },
      payload: { theme: 'dark' },
    });
    expect(theme.statusCode, theme.body).toBe(204);

    const me = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin.cookie } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().preferences).toMatchObject({ timezone: 'America/New_York', locale: 'de', theme: 'dark' });
  });
});
