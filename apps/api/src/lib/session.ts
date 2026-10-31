import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { session as sessionTable, user } from '@agent-tasks/database';
import { AppError } from '@agent-tasks/shared';
import type { Role } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  emailVerified: boolean;
}

/**
 * Better Auth's typed session no longer carries `impersonatedBy` now that the
 * admin plugin is not installed, but rows written while it was (or by any other
 * writer) still do. The runtime value is the security-relevant one, so narrow
 * structurally instead of casting to `any`.
 */
function isImpersonated(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const impersonatedBy = (value as Record<string, unknown>).impersonatedBy;
  return typeof impersonatedBy === 'string' && impersonatedBy.length > 0;
}

export async function sessionUser(context: AppContext, request: FastifyRequest): Promise<SessionUser | null> {
  const session = await context.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return null;
  // An impersonation session must never resolve to the victim's identity.
  if (isImpersonated(session.session)) return null;
  // Re-read the marker from the row as well: the adapter may filter plugin fields
  // out of the getSession payload, but the stored flag is authoritative.
  const rows = await context.db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      banned: user.banned,
      emailVerified: user.emailVerified,
      impersonatedBy: sessionTable.impersonatedBy,
    })
    .from(user)
    .innerJoin(sessionTable, and(eq(sessionTable.id, session.session.id), eq(sessionTable.userId, user.id)))
    .where(eq(user.id, session.user.id))
    .limit(1);
  const record = rows[0];
  if (!record || record.banned || isImpersonated(record)) return null;
  if (record.role !== 'ADMIN' && record.role !== 'USER') return null;
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    role: record.role,
    sessionId: session.session.id,
    emailVerified: record.emailVerified,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A malformed id is a 404, not a database error: it must not leak schema details. */
export function requireUuid(value: string, what = 'resource'): string {
  if (!UUID_PATTERN.test(value)) throw AppError.notFound(what);
  return value;
}

export async function requireUser(context: AppContext, request: FastifyRequest): Promise<SessionUser> {
  const found = await sessionUser(context, request);
  if (!found) throw AppError.unauthorized();
  return found;
}

export async function requireAdmin(context: AppContext, request: FastifyRequest): Promise<SessionUser> {
  const found = await requireUser(context, request);
  if (found.role !== 'ADMIN') throw AppError.forbidden('administrator role required');
  return found;
}

/** Every resource lookup is scoped by owner — no route ever trusts a body-supplied user id. */
export async function assertTaskOwner(context: AppContext, userId: string, taskId: string): Promise<void> {
  const rows = await context.db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.ownerId, userId)))
    .limit(1);
  if (rows.length === 0) throw AppError.notFound('task');
}

import { tasks as tasksTable } from '@agent-tasks/database';
