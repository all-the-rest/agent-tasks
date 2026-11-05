import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { taskShares, tasks } from '@agent-tasks/database';
import {
  AGENT_RUNTIME_LIMITS,
  AppError,
  DEFAULT_MEMORY_SETTINGS,
  nextOccurrence,
  scheduleSchema,
  taskShareAdoptSchema,
  taskShareSnapshotSchema,
} from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { assertTaskOwner, requireUser, requireUuid } from '../lib/session.js';
import { hashToken } from './setup.js';
import { assertTaskExecutable, omitTaskLimits } from './tasks.js';

/** A base64url 32-byte token is 43 characters; anything much longer is hostile. */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

function shareLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/share/${encodeURIComponent(token)}`;
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-robots-tag', 'noindex, nofollow');
}

/** A stored snapshot outside the closed contract must never be served. */
function parseStoredSnapshot(snapshot: unknown) {
  const parsed = taskShareSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw AppError.notFound('share');
  return parsed.data;
}

/**
 * Resolves an active share by its bearer token. Revoked, unknown and malformed
 * tokens all answer the same 404 so a link cannot be probed for existence.
 */
async function activeShare(context: AppContext, token: string) {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw AppError.notFound('share');
  const rows = await context.db
    .select({ id: taskShares.id, snapshot: taskShares.snapshot })
    .from(taskShares)
    .where(and(eq(taskShares.tokenHash, hashToken(token)), isNull(taskShares.revokedAt)))
    .limit(1);
  const share = rows[0];
  if (!share) throw AppError.notFound('share');
  return { id: share.id, snapshot: parseStoredSnapshot(share.snapshot) };
}

export async function registerTaskShareRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  /** Creates a new link. The plaintext token is returned exactly once. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/share', async (request, reply) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskOwner(context, me.id, taskId);
    const rows = await db
      .select({ title: tasks.title, prompt: tasks.prompt, schedule: tasks.schedule, timezone: tasks.timezone })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = rows[0];
    if (!task) throw AppError.notFound('task');
    const schedule = scheduleSchema.safeParse(task.schedule);
    if (!schedule.success) throw AppError.badRequest('task schedule is invalid');
    const snapshot = taskShareSnapshotSchema.safeParse({
      title: task.title,
      prompt: task.prompt,
      schedule: schedule.data,
      timezone: task.timezone,
    });
    if (!snapshot.success) throw AppError.badRequest('task cannot be shared', snapshot.error.issues);

    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const [created] = await db
      .insert(taskShares)
      .values({ id, taskId, ownerId: me.id, tokenHash: hashToken(token), snapshot: snapshot.data })
      .returning({ createdAt: taskShares.createdAt });
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.taskShareCreated,
      targetType: 'task',
      targetId: taskId,
      metadata: { shareId: id },
      ip: request.ip,
    });
    noStore(reply);
    reply.code(201);
    return { id, token, url: shareLink(context.env.PUBLIC_BASE_URL, token), createdAt: created?.createdAt };
  });

  /** Owner-only metadata listing. Tokens exist solely in the response of creation. */
  app.get<{ Params: { id: string } }>('/api/tasks/:id/shares', async (request, reply) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskOwner(context, me.id, taskId);
    noStore(reply);
    return db
      .select({ id: taskShares.id, createdAt: taskShares.createdAt, revokedAt: taskShares.revokedAt })
      .from(taskShares)
      .where(and(eq(taskShares.taskId, taskId), eq(taskShares.ownerId, me.id)))
      .orderBy(desc(taskShares.createdAt));
  });

  /** Revocation is permanent for this link and never touches already adopted copies. */
  app.delete<{ Params: { id: string; shareId: string } }>('/api/tasks/:id/shares/:shareId', async (request, reply) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const shareId = requireUuid(request.params.shareId, 'share');
    await assertTaskOwner(context, me.id, taskId);
    const revoked = await db
      .update(taskShares)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(taskShares.id, shareId),
          eq(taskShares.taskId, taskId),
          eq(taskShares.ownerId, me.id),
          isNull(taskShares.revokedAt),
        ),
      )
      .returning({ id: taskShares.id });
    if (revoked.length === 0) throw AppError.notFound('share');
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.taskShareRevoked,
      targetType: 'task',
      targetId: taskId,
      metadata: { shareId },
      ip: request.ip,
    });
    noStore(reply);
    reply.code(204);
    return null;
  });

  /**
   * Public read. No session is required and no owner, task id, memory, history
   * or credential data is reachable from here — only the frozen snapshot.
   */
  app.get<{ Params: { token: string } }>('/api/shares/:token', async (request, reply) => {
    const share = await activeShare(context, request.params.token);
    noStore(reply);
    return share.snapshot;
  });

  /**
   * Copy-on-adopt. The adopter must be signed in and supply their own executable
   * provider and model; the source task, its credentials, memory and history are
   * never read or copied.
   */
  app.post<{ Params: { token: string }; Body: unknown }>('/api/shares/:token/adopt', async (request, reply) => {
    const me = await requireUser(context, request);
    const parsed = taskShareAdoptSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid adoption', parsed.error.issues);
    const token = request.params.token;
    // Reject an unknown or revoked link before validating the adopter's provider,
    // so a dead link keeps answering the same 404. The authoritative check runs
    // again under the row lock below.
    await activeShare(context, token);
    // Research is the product default. The adopter's provider must therefore be
    // able to run tools, and the copy starts with no memory of the source task.
    await assertTaskExecutable(db, me.id, parsed.data.providerId, parsed.data.model, {
      allowWebResearch: true,
      notification: 'none',
      memoryMode: 'off',
    });

    const id = randomUUID();
    const { created, shareId } = await db.transaction(async (tx) => {
      // Lock the share row before inserting the copy. A concurrent revoke then
      // either commits first (the conditional select sees no row and this
      // adoption is refused) or waits until this transaction commits. Without
      // the lock, an adopt that had already read the share could still create a
      // task after DELETE had answered 204.
      const rows = await tx
        .select({ id: taskShares.id, snapshot: taskShares.snapshot })
        .from(taskShares)
        .where(and(eq(taskShares.tokenHash, hashToken(token)), isNull(taskShares.revokedAt)))
        .limit(1)
        .for('update');
      const locked = rows[0];
      if (!locked) throw AppError.notFound('share');
      const snapshot = parseStoredSnapshot(locked.snapshot);

      const now = new Date();
      const nextRunAt = nextOccurrence(snapshot.schedule, now);
      const [inserted] = await tx
        .insert(tasks)
        .values({
          id,
          ownerId: me.id,
          title: snapshot.title,
          description: null,
          prompt: snapshot.prompt,
          systemInstructions: null,
          providerId: parsed.data.providerId,
          model: parsed.data.model,
          enabled: nextRunAt !== null,
          schedule: snapshot.schedule,
          endCondition: { type: 'never' },
          scheduledRunCount: 0,
          completedAt: nextRunAt === null ? now : null,
          timezone: snapshot.timezone,
          limits: AGENT_RUNTIME_LIMITS,
          allowWebResearch: true,
          notification: 'none',
          memorySettings: DEFAULT_MEMORY_SETTINGS,
          nextRunAt,
        })
        .returning();
      if (!inserted) throw AppError.conflict('task could not be created');
      return { created: inserted, shareId: locked.id };
    });
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.taskShareAdopted,
      targetType: 'task',
      targetId: id,
      metadata: { shareId },
      ip: request.ip,
    });
    noStore(reply);
    reply.code(201);
    return omitTaskLimits(created);
  });
}
