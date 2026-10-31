import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { auditLogs, invitations, providers, user } from '@agent-tasks/database';
import { bootstrapAdmin, createHarness, inviteAndAccept } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

async function lastAudit(action: string) {
  const rows = await harness.db.db.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(desc(auditLogs.createdAt)).limit(1);
  return rows[0];
}

describe('audit log', () => {
  it('records setup, invitation, role change, provider and credential operations', async () => {
    const admin = await bootstrapAdmin(harness);
    const setup = await lastAudit('setup.completed');
    expect(setup?.actorId).toBe(admin.id);
    expect(setup?.targetType).toBe('user');

    const invited = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie: admin.cookie },
      payload: { email: 'audited@example.com', role: 'USER' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const inviteAudit = await lastAudit('user.invited');
    expect(inviteAudit?.actorId).toBe(admin.id);
    expect(inviteAudit?.metadata).toMatchObject({ email: 'audited@example.com', role: 'USER' });

    const invitedUser = await inviteAndAccept(harness, admin.cookie, 'member@example.com');
    const member = await harness.db.db.select({ id: user.id }).from(user).where(eq(user.email, 'member@example.com')).limit(1);
    const promoted = await harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${member[0]?.id}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'ADMIN' },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect((await lastAudit('user.role_changed'))?.actorId).toBe(admin.id);

    const provider = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      headers: { cookie: admin.cookie },
      payload: { name: 'Audit provider', kind: 'openai-compatible', config: { baseUrl: 'http://127.0.0.1:9/v1' } },
    });
    expect(provider.statusCode, provider.body).toBe(201);
    expect((await lastAudit('provider.created'))?.targetId).toBe(provider.json().id);

    const credential = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/providers/${provider.json().id}/credentials`,
      headers: { cookie: admin.cookie },
      payload: { apiKey: 'audit-secret-key-123' },
    });
    expect(credential.statusCode, credential.body).toBe(201);
    expect((await lastAudit('credential.created'))?.actorId).toBe(admin.id);

    // The audit trail must never contain the credential itself.
    const all = await harness.db.db.select().from(auditLogs);
    expect(JSON.stringify(all)).not.toContain('audit-secret-key-123');
    expect(invitedUser.cookie).toBeTruthy();
    expect(await harness.db.db.select().from(invitations).then((rows) => rows.length)).toBeGreaterThan(0);
    expect(await harness.db.db.select().from(providers).then((rows) => rows.length)).toBe(1);
  });
});
