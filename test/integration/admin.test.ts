import { randomUUID } from 'node:crypto';
import { HARD_LIMITS } from '@agent-tasks/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('administrator invariants', () => {
  it('writes an audit row for every sensitive administrative action', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const invited = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie: admin.cookie },
      payload: { email: 'audited@example.com', role: 'USER' },
    });
    expect(invited.statusCode, invited.body).toBe(201);

    const settings = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { allowRegistration: false },
    });
    expect(settings.statusCode, settings.body).toBe(200);

    const provider = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: admin.cookie },
      payload: { name: 'Audited provider', kind: 'openai-compatible', config: { baseUrl: 'http://mock:8080/v1' } },
    });
    expect(provider.statusCode, provider.body).toBe(201);
    const providerId = provider.json().id as string;

    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `/api/admin/providers/${providerId}`,
      headers: { cookie: admin.cookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);

    const rows = await harness.db.pool.query(
      'select action, target_type, target_id from audit_logs where actor_id = $1 order by created_at',
      [admin.id],
    );
    const actions = rows.rows.map((row) => row.action);
    for (const expected of ['setup.completed', 'user.invited', 'settings.updated', 'provider.created', 'provider.deleted']) {
      expect(actions, JSON.stringify(rows.rows)).toContain(expected);
    }
    const providerEvent = rows.rows.find((row) => row.action === 'provider.created');
    // Audit metadata must identify the target without storing the credential.
    expect(providerEvent).toMatchObject({ target_type: 'provider', target_id: providerId });
    expect(JSON.stringify(rows.rows)).not.toContain('mock-api-key');
  });

  it('persists administrator-configured global per-run limits within the hard caps', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { agentLimits: { maxDurationSec: 600, maxAgentSteps: 12, maxPageVisits: 0 } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().agentLimits).toEqual({
      ...HARD_LIMITS,
      maxDurationSec: 600,
      maxAgentSteps: 12,
      maxPageVisits: 0,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().agentLimits).toEqual(saved.json().agentLimits);

    const raised = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { agentLimits: { maxDurationSec: HARD_LIMITS.maxDurationSec + 1 } },
    });
    expect(raised.statusCode, raised.body).toBe(400);
  });

  it('refuses production open registration when the mailer cannot send verification e-mail', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    harness.context.env.NODE_ENV = 'production';

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { allowRegistration: true },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('SMTP_URL');

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
    });
    expect(settings.json().allowRegistration).toBe(false);
  });

  it('answers 404 for a malformed invitation id instead of a database error', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/admin/invitations/not-a-uuid',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode, response.body).toBe(404);
  });

  it('keeps one administrator when two admins demote each other concurrently', async () => {
    harness = await createHarness();
    const first = await bootstrapAdmin(harness);
    const second = await inviteAndAccept(harness, first.cookie, 'second-admin@example.com');

    const promoted = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${second.id}`,
      headers: { cookie: first.cookie },
      payload: { role: 'ADMIN' },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().role).toBe('ADMIN');

    const [firstDemoted, secondDemoted] = await Promise.all([
      harness.app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${second.id}`,
        headers: { cookie: first.cookie },
        payload: { role: 'USER' },
      }),
      harness.app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${first.id}`,
        headers: { cookie: second.cookie },
        payload: { role: 'USER' },
      }),
    ]);

    expect([firstDemoted.statusCode, secondDemoted.statusCode].sort()).toEqual([200, 409]);

    const admins = await harness.db.pool.query<{ count: number }>(
      'select count(*)::int as count from "user" where role = $1 and banned = false',
      ['ADMIN'],
    );
    expect(admins.rows[0]?.count).toBe(1);
  });

  it('reports setup as unconfigured while only a roleless user exists, so setup can be repaired', async () => {
    harness = await createHarness();
    await harness.db.pool.query(
      `insert into "user" (id, name, email, email_verified, role) values ($1, 'Half Created', 'half@example.com', false, 'USER')`,
      [randomUUID()],
    );

    const before = await harness.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({ configured: false });

    const setup = await harness.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: harness.env.SETUP_TOKEN, email: 'real-admin@example.com', password: 'admin-password-123', name: 'Admin' },
    });
    expect(setup.statusCode, setup.body).toBe(200);

    const after = await harness.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(after.json()).toEqual({ configured: true });

    const admins = await harness.db.pool.query<{ count: number }>(
      'select count(*)::int as count from "user" where role = $1',
      ['ADMIN'],
    );
    expect(admins.rows[0]?.count).toBe(1);
  });
});
