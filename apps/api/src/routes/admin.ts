import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { auditLogs, executions, invitations, tasks, user, userPreferences } from '@agent-tasks/database';
import { AppError, inviteSchema, roleSchema, systemSettingsSchema } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { saveSettings } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { renderActionEmail } from '../lib/email-templates.js';
import { hashToken } from './setup.js';
import { requireAdmin, requireUser, requireUuid } from '../lib/session.js';

export async function registerMeRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  app.get('/api/me', async (request) => {
    const me = await requireUser(context, request);
    const preferences = await db.select().from(userPreferences).where(eq(userPreferences.userId, me.id)).limit(1);
    const settings = await context.settings();
    return {
      user: { id: me.id, email: me.email, name: me.name, role: me.role, emailVerified: me.emailVerified },
      preferences: preferences[0] ?? { timezone: settings.defaultTimezone, locale: 'en', theme: 'system' },
      limits: {
        maxConcurrentExecutionsPerUser: settings.maxConcurrentExecutionsPerUser,
        maxTaskExecutionsPerDay: settings.maxTaskExecutionsPerDay,
      },
    };
  });

  app.get('/api/dashboard', async (request) => {
    const me = await requireUser(context, request);
    const taskRows = await db
      .select({ id: tasks.id, title: tasks.title, enabled: tasks.enabled, nextRunAt: tasks.nextRunAt, schedule: tasks.schedule })
      .from(tasks)
      .where(eq(tasks.ownerId, me.id))
      .orderBy(tasks.nextRunAt)
      .limit(100);
    const recent = await db
      .select({
        id: executions.id,
        taskId: executions.taskId,
        taskTitle: executions.taskTitle,
        status: executions.status,
        startedAt: executions.startedAt,
        finishedAt: executions.finishedAt,
        error: executions.error,
      })
      .from(executions)
      .where(eq(executions.ownerId, me.id))
      .orderBy(desc(executions.createdAt))
      .limit(10);
    return {
      activeTasks: taskRows.filter((task) => task.enabled),
      pausedTasks: taskRows.filter((task) => !task.enabled),
      recentExecutions: recent,
      failures: recent.filter((execution) => execution.status === 'failed' || execution.status === 'timed_out'),
    };
  });
}

/** Serialises role/ban changes so the last-admin check and the write are one unit. */
const ADMIN_GUARD_LOCK_ID = 761_211_002;

export async function registerAdminRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, env, mailer } = context;

  app.get('/api/admin/users', async (request) => {
    await requireAdmin(context, request);
    const rows = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        banned: user.banned,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .orderBy(desc(user.createdAt));
    return rows;
  });

  app.patch<{ Params: { id: string }; Body: { role?: string; banned?: boolean; name?: string } }>('/api/admin/users/:id', async (request) => {
    const admin = await requireAdmin(context, request);
    if (request.params.id === admin.id && request.body?.role && request.body.role !== 'ADMIN') {
      throw AppError.badRequest('an administrator cannot demote themselves');
    }
    if (request.params.id === admin.id && request.body?.banned) {
      throw AppError.badRequest('an administrator cannot disable themselves');
    }
    const parsedRole = request.body?.role ? roleSchema.safeParse(request.body.role) : null;
    if (parsedRole && !parsedRole.success) throw AppError.badRequest('unknown role');

    /*
     * Check-then-update is not safe: two administrators can demote each other
     * concurrently and both see two active admins. The transaction-scoped advisory
     * lock serialises every role/ban mutation, and the target + admin count are
     * re-read after acquiring it.
     */
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_GUARD_LOCK_ID})`);
      const target = await tx
        .select({ id: user.id, role: user.role })
        .from(user)
        .where(eq(user.id, request.params.id))
        .limit(1)
        .for('update');
      if (!target[0]) throw AppError.notFound('user');
      if (target[0].role === 'ADMIN' && (parsedRole?.data === 'USER' || request.body?.banned)) {
        const adminRows = await tx.select({ value: count() }).from(user).where(and(eq(user.role, 'ADMIN'), eq(user.banned, false)));
        if (Number(adminRows[0]?.value ?? 0) <= 1) throw AppError.conflict('the last active administrator cannot be demoted or disabled');
      }

      const [row] = await tx
        .update(user)
        .set({
          ...(parsedRole?.data ? { role: parsedRole.data } : {}),
          ...(request.body?.banned !== undefined ? { banned: request.body.banned, banReason: request.body.banned ? 'disabled by administrator' : null } : {}),
          ...(request.body?.name ? { name: request.body.name } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, request.params.id))
        .returning({ id: user.id, role: user.role, banned: user.banned });
      return row;
    });

    await context.audit({
      actorId: admin.id,
      action: request.body?.banned === true ? AUDIT_ACTIONS.userDisabled : request.body?.banned === false ? AUDIT_ACTIONS.userEnabled : AUDIT_ACTIONS.userRoleChanged,
      targetType: 'user',
      targetId: request.params.id,
      metadata: { role: updated?.role, banned: updated?.banned },
    });
    return updated;
  });

  app.get('/api/admin/invitations', async (request) => {
    await requireAdmin(context, request);
    return db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .orderBy(desc(invitations.createdAt))
      .limit(100);
  });

  app.post<{ Body: unknown }>('/api/admin/invitations', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid invitation', parsed.error.issues);
    const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, parsed.data.email)).limit(1);
    if (existing.length > 0) throw AppError.conflict('a user with this address already exists');

    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await db.insert(invitations).values({
      id,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenHash: hashToken(token),
      invitedBy: admin.id,
      expiresAt,
    });
    const link = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/invite/${token}`;
    const content = renderActionEmail({
      heading: 'You are invited to Agent Tasks',
      paragraphs: ['An administrator invited you to Agent Tasks. Open the single-use link within 7 days to create your account.'],
      actionLabel: 'Accept invitation',
      actionUrl: link,
      footer: 'If you were not expecting this invitation, ignore this mail.',
    });
    await mailer.send({ to: parsed.data.email, subject: 'You are invited to Agent Tasks', ...content });
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.userInvited, targetType: 'invitation', targetId: id, metadata: { email: parsed.data.email, role: parsed.data.role } });
    reply.code(201);
    return { id, token, expiresAt, link };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/invitations/:id', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const invitationId = requireUuid(request.params.id, 'invitation');
    const updated = await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id });
    if (updated.length === 0) throw AppError.notFound('invitation');
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.inviteRevoked, targetType: 'invitation', targetId: invitationId });
    reply.code(204);
    return null;
  });

  app.get('/api/admin/settings', async (request) => {
    await requireAdmin(context, request);
    return context.settings();
  });

  app.put<{ Body: unknown }>('/api/admin/settings', async (request) => {
    const admin = await requireAdmin(context, request);
    const parsed = systemSettingsSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid settings', parsed.error.issues);
    await saveSettings(db, parsed.data);
    context.invalidateSettings();
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.settingsUpdated, targetType: 'settings', metadata: parsed.data });
    return parsed.data;
  });

  app.get('/api/admin/audit', async (request) => {
    await requireAdmin(context, request);
    return db
      .select({
        id: auditLogs.id,
        actorId: auditLogs.actorId,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        metadata: auditLogs.metadata,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
  });

  app.get('/api/admin/metrics', async (request) => {
    await requireAdmin(context, request);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const statusRows = await db.select({ status: executions.status, value: count() }).from(executions).groupBy(executions.status);
    const last24Rows = await db.select({ value: count() }).from(executions).where(gte(executions.createdAt, since));
    const userRows = await db.select({ value: count() }).from(user);
    const taskRows = await db.select({ value: count() }).from(tasks);
    const runningRows = await db
      .select({ value: count() })
      .from(executions)
      .where(sql`${executions.status} in ('queued','running')`);
    const last24 = last24Rows[0]?.value ?? 0;
    const users = userRows[0]?.value ?? 0;
    const tasksTotal = taskRows[0]?.value ?? 0;
    const running = runningRows[0]?.value ?? 0;
    return {
      users: Number(users),
      tasks: Number(tasksTotal),
      executionsLast24h: Number(last24),
      active: Number(running),
      byStatus: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.value)])),
    };
  });
}
