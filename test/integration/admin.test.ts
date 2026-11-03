import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('administrator invariants', () => {
  it('does not expose legacy per-agent limits through system settings', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { agentLimits: { maxDurationSec: 30, maxAgentSteps: 1 } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).not.toHaveProperty('agentLimits');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).not.toHaveProperty('agentLimits');
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
