import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { executions, providerCredentials, providers, tasks } from '@agent-tasks/database';
import {
  AppError,
  HARD_LIMITS,
  nextOccurrence,
  scheduleSchema,
  taskInputSchema,
  taskUpdateSchema,
  describeSchedule,
} from '@agent-tasks/shared';
import type { ParsedSchedule } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { requireUser, requireUuid } from '../lib/session.js';
import { enqueueExecution } from '../lib/queue.js';

function parseSchedule(input: unknown): ParsedSchedule {
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) throw AppError.badRequest('invalid schedule', parsed.error.issues);
  return parsed.data;
}

async function assertProviderUsable(context: AppContext, userId: string, providerId: string): Promise<{ kind: string; name: string }> {
  const rows = await context.db
    .select({ id: providers.id, kind: providers.kind, name: providers.name, enabled: providers.enabled })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  const provider = rows[0];
  if (!provider) throw AppError.badRequest('unknown provider');
  if (!provider.enabled) throw AppError.badRequest('provider is disabled');
  if (provider.kind === 'openai' || provider.kind === 'openai-compatible' || provider.kind === 'codex') {
    const credentials = await context.db
      .select({ ownerId: providerCredentials.ownerId })
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, providerId));
    const usable = credentials.some((credential) => credential.ownerId === null || credential.ownerId === userId);
    if (!usable) throw AppError.badRequest('no usable credential for this provider');
  }
  return { kind: provider.kind, name: provider.name };
}

export async function registerTaskRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  app.get<{ Querystring: { limit?: string; status?: string } }>('/api/tasks', async (request) => {
    const me = await requireUser(context, request);
    const limit = Math.min(Number(request.query.limit ?? 50), 100);
    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.ownerId, me.id))
      .orderBy(desc(tasks.createdAt))
      .limit(limit);
    return rows.map((task) => ({
      ...task,
      scheduleDescription: describeSchedule(scheduleSchema.parse(task.schedule)),
    }));
  });

  app.post<{ Body: unknown }>('/api/tasks', async (request, reply) => {
    const me = await requireUser(context, request);
    const parsed = taskInputSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid task', parsed.error.issues);
    const provider = await assertProviderUsable(context, me.id, parsed.data.providerId);
    const schedule = parsed.data.schedule;
    const nextRunAt = nextOccurrence(schedule);
    if (parsed.data.enabled && !nextRunAt) throw AppError.badRequest('the schedule has no future occurrence');

    const id = randomUUID();
    const [created] = await db
      .insert(tasks)
      .values({
        id,
        ownerId: me.id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        prompt: parsed.data.prompt,
        systemInstructions: parsed.data.systemInstructions ?? null,
        providerId: parsed.data.providerId,
        model: parsed.data.model,
        enabled: parsed.data.enabled,
        schedule,
        timezone: schedule.timezone,
        limits: parsed.data.limits,
        allowWebResearch: parsed.data.allowWebResearch,
        notification: parsed.data.notification,
        nextRunAt: parsed.data.enabled ? nextRunAt : null,
      })
      .returning();
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.taskCreated,
      targetType: 'task',
      targetId: id,
      metadata: { provider: provider.name, model: parsed.data.model },
      ip: request.ip,
    });
    reply.code(201);
    return created;
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = rows[0];
    if (!task) throw AppError.notFound('task');
    return { ...task, scheduleDescription: describeSchedule(scheduleSchema.parse(task.schedule)) };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/tasks/:id', async (request) => {
    const me = await requireUser(context, request);
    const parsed = taskUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid task', parsed.error.issues);
    const taskId = requireUuid(request.params.id, 'task');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    if (!rows[0]) throw AppError.notFound('task');
    if (parsed.data.providerId) await assertProviderUsable(context, me.id, parsed.data.providerId);
    if (parsed.data.limits) {
      const limit = parsed.data.limits;
      if (limit.maxDurationSec > HARD_LIMITS.maxDurationSec || limit.maxAgentSteps > HARD_LIMITS.maxAgentSteps || limit.maxPageVisits > HARD_LIMITS.maxPageVisits) {
        throw AppError.badRequest('limits exceed the hard maximum');
      }
    }
    const schedule = parsed.data.schedule ? parseSchedule(parsed.data.schedule) : null;
    const enabled = parsed.data.enabled ?? rows[0].enabled;
    const scheduleChanged = schedule !== null;
    const enabledChanged = parsed.data.enabled !== undefined && parsed.data.enabled !== rows[0].enabled;
    // Only a real schedule/enabled change may move nextRunAt. A title-only PATCH must
    // not resume a paused task or re-book an existing occurrence.
    const nextRunAt = !enabled
      ? null
      : scheduleChanged || enabledChanged
        ? nextOccurrence(schedule ?? scheduleSchema.parse(rows[0].schedule))
        : undefined;

    const [updated] = await db
      .update(tasks)
      .set({
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
        ...(parsed.data.systemInstructions !== undefined ? { systemInstructions: parsed.data.systemInstructions } : {}),
        ...(parsed.data.providerId ? { providerId: parsed.data.providerId } : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(parsed.data.limits ? { limits: parsed.data.limits } : {}),
        ...(parsed.data.allowWebResearch !== undefined ? { allowWebResearch: parsed.data.allowWebResearch } : {}),
        ...(parsed.data.notification ? { notification: parsed.data.notification } : {}),
        ...(schedule ? { schedule, timezone: schedule.timezone } : {}),
        enabled,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, request.params.id), eq(tasks.ownerId, me.id)))
      .returning();
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.taskUpdated, targetType: 'task', targetId: request.params.id });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const deleted = await db
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .returning({ id: tasks.id });
    if (deleted.length === 0) throw AppError.notFound('task');
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.taskDeleted, targetType: 'task', targetId: request.params.id });
    reply.code(204);
    return null;
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/pause', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const [updated] = await db
      .update(tasks)
      .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .returning();
    if (!updated) throw AppError.notFound('task');
    return updated;
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = rows[0];
    if (!task) throw AppError.notFound('task');
    const next = nextOccurrence(scheduleSchema.parse(task.schedule));
    const [updated] = await db
      .update(tasks)
      .set({ enabled: true, nextRunAt: next, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.ownerId, me.id)))
      .returning();
    return updated;
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = rows[0];
    if (!task) throw AppError.notFound('task');

    const active = await db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(and(eq(executions.taskId, task.id), inArray(executions.status, ['queued', 'running'])))
      .limit(1);
    if (active.length > 0) throw AppError.conflict('this task already has a queued or running execution');

    const executionId = randomUUID();
    await db.insert(executions).values({
      id: executionId,
      taskId: task.id,
      ownerId: me.id,
      taskTitle: task.title,
      status: 'queued',
      trigger: 'manual',
      providerId: task.providerId,
      model: task.model,
    });
    await enqueueExecution(context.env.DATABASE_URL, executionId);
    return { executionId };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/duplicate', async (request, reply) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = rows[0];
    if (!task) throw AppError.notFound('task');
    const id = randomUUID();
    const [copy] = await db
      .insert(tasks)
      .values({
        ...task,
        id,
        title: `${task.title} (copy)`,
        enabled: false,
        nextRunAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    reply.code(201);
    return copy;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/api/tasks/:id/executions', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    if (!taskRows[0]) throw AppError.notFound('task');
    const limit = Math.min(Number(request.query.limit ?? 20), 100);
    const before = request.query.before ? new Date(request.query.before) : null;
    const conditions = [eq(executions.taskId, taskId)];
    if (before) conditions.push(lt(executions.createdAt, before));
    const rows = await db
      .select({
        id: executions.id,
        status: executions.status,
        trigger: executions.trigger,
        startedAt: executions.startedAt,
        finishedAt: executions.finishedAt,
        durationMs: executions.durationMs,
        error: executions.error,
        taskTitle: executions.taskTitle,
        scheduledFor: executions.scheduledFor,
      })
      .from(executions)
      .where(and(...conditions))
      .orderBy(desc(executions.createdAt))
      .limit(limit);
    return rows;
  });

  app.get<{ Querystring: { limit?: string; status?: string } }>('/api/executions', async (request) => {
    const me = await requireUser(context, request);
    const limit = Math.min(Number(request.query.limit ?? 25), 100);
    const conditions = [eq(executions.ownerId, me.id)];
    if (request.query.status) conditions.push(eq(executions.status, request.query.status));
    return db
      .select({
        id: executions.id,
        taskId: executions.taskId,
        taskTitle: executions.taskTitle,
        status: executions.status,
        trigger: executions.trigger,
        startedAt: executions.startedAt,
        finishedAt: executions.finishedAt,
        durationMs: executions.durationMs,
        error: executions.error,
      })
      .from(executions)
      .where(and(...conditions))
      .orderBy(desc(executions.createdAt))
      .limit(limit);
  });

  app.get<{ Params: { id: string } }>('/api/executions/:id', async (request) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const execution = rows[0];
    if (!execution) throw AppError.notFound('execution');
    const steps = await db
      .select()
      .from(executionStepsTable)
      .where(eq(executionStepsTable.executionId, execution.id))
      .orderBy(executionStepsTable.step);
    return { ...execution, steps };
  });

  app.post<{ Params: { id: string } }>('/api/executions/:id/cancel', async (request) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const execution = rows[0];
    if (!execution) throw AppError.notFound('execution');
    if (!['queued', 'running'].includes(execution.status)) throw AppError.conflict('execution is already finished');
    await db.update(executions).set({ cancelRequested: true }).where(eq(executions.id, execution.id));
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.executionCancelled, targetType: 'execution', targetId: execution.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/executions/:id/retry', async (request, reply) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const previous = rows[0];
    if (!previous) throw AppError.notFound('execution');
    if (!['failed', 'timed_out', 'cancelled'].includes(previous.status)) throw AppError.conflict('only failed, timed out or cancelled executions can be retried');
    const taskRows = await db.select().from(tasks).where(and(eq(tasks.id, previous.taskId), eq(tasks.ownerId, me.id))).limit(1);
    const task = taskRows[0];
    if (!task) throw AppError.notFound('task');
    const id = randomUUID();
    await db.insert(executions).values({
      id,
      taskId: task.id,
      ownerId: me.id,
      taskTitle: task.title,
      status: 'queued',
      trigger: 'retry',
      attempt: previous.attempt + 1,
      providerId: task.providerId,
      model: task.model,
    });
    await enqueueExecution(context.env.DATABASE_URL, id);
    reply.code(201);
    return { executionId: id };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/executions/:id/export', async (request, reply) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const execution = rows[0];
    if (!execution) throw AppError.notFound('execution');
    const format = request.query.format === 'json' ? 'json' : 'md';
    const safeName = execution.taskTitle.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60);
    if (format === 'json') {
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', `attachment; filename="${safeName}.json"`);
      return { id: execution.id, taskId: execution.taskId, status: execution.status, report: execution.report, usage: execution.usage };
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${safeName}.md"`);
    const report = execution.report as { markdown?: string; sources?: Array<{ url: string; title?: string; confidence: string; retrievedAt: string }> } | null;
    const sourceLines = (report?.sources ?? []).map((source) => `- [${source.title ?? source.url}](${source.url}) — ${source.confidence}, ${source.retrievedAt}`);
    return [`# ${execution.taskTitle}`, '', report?.markdown ?? '_no report_', '', '## Sources', '', ...sourceLines].join('\n');
  });
}

import { executionSteps as executionStepsTable } from '@agent-tasks/database';
