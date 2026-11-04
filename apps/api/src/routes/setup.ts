import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { invitations, user, userPreferences } from '@agent-tasks/database';
import type { Database } from '@agent-tasks/database';
import { AppError, acceptInviteSchema, isValidTimeZone, userPreferencesUpdateSchema } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { withTrustedSignup } from '../auth.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ClaimedInvitation {
  id: string;
  email: string;
  role: string;
}

/**
 * Atomically claims a single-use invitation. `UPDATE … WHERE … RETURNING` is the
 * compare-and-swap: PostgreSQL serialises concurrent updates on the row, and the
 * loser re-evaluates its WHERE clause against the committed row (accepted_at is
 * now set), so exactly one caller gets a row back. No SELECT-then-write window.
 */
export async function claimInvitation(db: Database, token: string): Promise<ClaimedInvitation | null> {
  const rows = await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .returning({ id: invitations.id, email: invitations.email, role: invitations.role });
  return rows[0] ?? null;
}

/** Gives a claim back when account creation failed, so the invite stays usable. */
export async function releaseInvitation(db: Database, id: string): Promise<void> {
  await db.update(invitations).set({ acceptedAt: null }).where(eq(invitations.id, id));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface InvitationPreview {
  email: string;
  role: string;
  expiresAt: Date;
}

/**
 * A token is previewable only while it is usable. Accepted, revoked and expired
 * invitations answer exactly like unknown tokens. Both preview routes go through
 * this lookup so their state checks cannot drift apart.
 */
async function findUsableInvitation(db: Database, token: string): Promise<InvitationPreview | null> {
  const rows = await db
    .select({ email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function registerSetupRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, env, auth, mailer } = context;

  app.get('/api/healthz', async () => {
    // A process that is up but cannot reach PostgreSQL must not report healthy.
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  app.get('/api/config', async () => {
    const settings = await context.settings();
    return {
      appName: 'Agent Tasks',
      allowRegistration: settings.allowRegistration,
      defaultTimezone: settings.defaultTimezone,
      scheduleTimePresets: settings.scheduleTimePresets,
      mailer: mailer.kind,
      version: '0.2.1',
    };
  });

  app.get('/api/setup/status', async () => {
    // An ADMIN is what makes the instance usable. Counting any user would leave a
    // half-finished setup (sign-up succeeded, role write failed) permanently stuck.
    const rows = await db.select({ count: sql<number>`count(*)::int` }).from(user).where(eq(user.role, 'ADMIN'));
    return { configured: Number(rows[0]?.count ?? 0) > 0 };
  });

  /**
   * First-admin initialisation. Guarded by SETUP_TOKEN (never a default password):
   * the deployment prints a random token at startup, the operator pastes it here
   * once. After the first admin exists the endpoint refuses every further call.
   *
   * The count check and the insert happen under a transaction-scoped advisory
   * lock, so two requests carrying SETUP_TOKEN cannot both observe zero users.
   * The account itself is created through Better Auth on its own connection; the
   * lock is held until this transaction commits, so the loser re-checks after the
   * winner's user row is visible.
   */
  const SETUP_LOCK_ID = 761_211_001;
  app.post<{ Body: { token?: string; email?: string; password?: string; name?: string } }>('/api/setup', async (request) => {
    const settings = await context.settings();
    let createdUserId: string | null = null;
    let adminId: string;
    try {
      adminId = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID})`);

        const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(user).where(eq(user.role, 'ADMIN'));
        if (Number(countRows[0]?.count ?? 0) > 0) throw AppError.conflict('setup already completed');
        if (!env.SETUP_TOKEN) throw new AppError('internal', 'SETUP_TOKEN is not configured on the server', 503);
        const body = request.body ?? {};
        if (!body.token || !safeEqual(body.token, env.SETUP_TOKEN)) throw AppError.forbidden('invalid setup token');
        const { email, password, name } = body;
        if (!email || !password || !name) throw AppError.badRequest('email, password and name are required');
        if (password.length < 12) throw AppError.badRequest('password must be at least 12 characters');

        const result = await withTrustedSignup(() => auth.api.signUpEmail({
          body: { email, password, name },
        }));
        // Better Auth writes on its own connection, so this transaction cannot roll it
        // back. Remember the id and compensate after the rollback if a later step fails.
        createdUserId = result.user.id;
        await tx.update(user).set({ role: 'ADMIN', emailVerified: true }).where(eq(user.id, result.user.id));
        await tx.insert(userPreferences).values({ userId: result.user.id, timezone: settings.defaultTimezone }).onConflictDoNothing();
        return result.user.id;
      });
    } catch (error) {
      if (createdUserId) {
        await db.delete(user).where(eq(user.id, createdUserId)).catch(() => undefined);
      }
      throw error;
    }

    await context.audit({ actorId: adminId, action: AUDIT_ACTIONS.setupCompleted, targetType: 'user', targetId: adminId, ip: request.ip });
    return { ok: true };
  });

  const previewInvitation = async (token: string): Promise<InvitationPreview> => {
    const invite = await findUsableInvitation(db, token);
    if (!invite) throw AppError.notFound('invitation');
    return invite;
  };

  app.get<{ Params: { token: string } }>('/api/invitations/:token', async (request) =>
    previewInvitation(request.params.token),
  );

  app.post<{ Body: unknown }>('/api/invitations/accept', async (request) => {
    const parsed = acceptInviteSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid invite payload', parsed.error.issues);
    const invite = await claimInvitation(db, parsed.data.token);
    if (!invite) throw AppError.notFound('invitation');

    let created;
    try {
      created = await withTrustedSignup(() => auth.api.signUpEmail({
        body: { email: invite.email, password: parsed.data.password, name: parsed.data.name },
      }));
    } catch (error) {
      // Give the claim back: the invitation is still unused if no account exists.
      await releaseInvitation(db, invite.id);
      throw AppError.badRequest((error as Error).message || 'could not create the account');
    }

    await db.update(user).set({ role: invite.role, emailVerified: true }).where(eq(user.id, created.user.id));
    const settings = await context.settings();
    await db.insert(userPreferences).values({ userId: created.user.id, timezone: settings.defaultTimezone }).onConflictDoNothing();
    await context.audit({
      actorId: created.user.id,
      action: AUDIT_ACTIONS.inviteAccepted,
      targetType: 'invitation',
      targetId: invite.id,
      metadata: { email: invite.email },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/api/invitations/:token/preview', async (request) =>
    previewInvitation(request.params.token),
  );

  app.patch<{ Body: { timezone?: string; locale?: string; theme?: string } }>('/api/me/preferences', async (request, reply) => {
    const { requireUser } = await import('../lib/session.js');
    const me = await requireUser(context, request);
    const parsed = userPreferencesUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid preferences', parsed.error.issues);
    if (parsed.data.timezone && !isValidTimeZone(parsed.data.timezone)) throw AppError.badRequest('unknown timezone');
    await db.insert(userPreferences).values({ userId: me.id, ...parsed.data } as never).onConflictDoUpdate({
      target: userPreferences.userId,
      set: parsed.data,
    });
    reply.code(204);
    return null;
  });
}
