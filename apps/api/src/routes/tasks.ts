import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { executions, providerCredentials, providers, tasks } from '@agent-tasks/database';
import {
  AppError,
  AGENT_RUNTIME_LIMITS,
  isAfterTaskEndDate,
  isTaskEndConditionReached,
  monthlyDays,
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

function scheduleIdentity(schedule: ParsedSchedule): string {
  const common = { preset: schedule.preset, timezone: schedule.timezone };
  switch (schedule.preset) {
    case 'once':
      return JSON.stringify({ ...common, runAt: schedule.runAt });
    case 'daily':
      return JSON.stringify({ ...common, hour: schedule.hour, minute: schedule.minute });
    case 'weekdays':
    case 'weekly':
      return JSON.stringify({
        ...common,
        hour: schedule.hour,
        minute: schedule.minute,
        weekdays: [...(schedule.weekdays ?? [])].sort((a, b) => a - b),
      });
    case 'monthly':
      return JSON.stringify({ ...common, hour: schedule.hour, minute: schedule.minute, daysOfMonth: monthlyDays(schedule) });
    case 'custom':
      return JSON.stringify({ ...common, cron: schedule.cron?.trim() });
  }
}

function omitTaskLimits<T extends { limits: unknown }>(task: T): Omit<T, 'limits'>;
function omitTaskLimits<T extends { limits: unknown }>(task: T | undefined): Omit<T, 'limits'> | undefined;
function omitTaskLimits<T extends { limits: unknown }>(task: T | undefined): Omit<T, 'limits'> | undefined {
  if (!task) return undefined;
  const { limits, ...response } = task;
  void limits;
  return response;
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
      ...omitTaskLimits(task),
      scheduleDescription: describeSchedule(scheduleSchema.parse(task.schedule)),
    }));
  });

  app.post<{ Body: unknown }>('/api/tasks', async (request, reply) => {
    const me = await requireUser(context, request);
    const parsed = taskInputSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid task', parsed.error.issues);
    const provider = await assertProviderUsable(context, me.id, parsed.data.providerId);
    const schedule = parsed.data.schedule;
    const now = new Date();
    const endConditionReached = isTaskEndConditionReached(parsed.data.endCondition, {
      timezone: schedule.timezone,
      scheduledRunCount: 0,
      now,
    });
    const enabled = parsed.data.enabled && !endConditionReached;
    const nextRunAt = enabled ? nextOccurrence(schedule, now) : null;
    if (enabled && !nextRunAt) throw AppError.badRequest('the schedule has no future occurrence');
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
        enabled,
        schedule,
        endCondition: parsed.data.endCondition,
        scheduledRunCount: 0,
        completedAt: endConditionReached ? now : null,
        timezone: schedule.timezone,
        // Keep fixed limits in the legacy column for compatibility. The worker now
        // passes these fixed bounds directly instead of administrator-configurable values.
        limits: AGENT_RUNTIME_LIMITS,
        allowWebResearch: parsed.data.allowWebResearch,
        notification: parsed.data.notification,
        memorySettings: parsed.data.memorySettings,
        nextRunAt,
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
    return omitTaskLimits(created);
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
    return { ...omitTaskLimits(task), scheduleDescription: describeSchedule(scheduleSchema.parse(task.schedule)) };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/tasks/:id', async (request) => {
    const me = await requireUser(context, request);
    const parsed = taskUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid task', parsed.error.issues);
    const taskId = requireUuid(request.params.id, 'task');
    if (parsed.data.providerId) await assertProviderUsable(context, me.id, parsed.data.providerId);
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .limit(1)
        .for('update');
      const current = rows[0];
      if (!current) throw AppError.notFound('task');

      const schedule = parsed.data.schedule ? parseSchedule(parsed.data.schedule) : null;
      const currentSchedule = scheduleSchema.parse(current.schedule);
      const effectiveSchedule = schedule ?? currentSchedule;
      const endCondition = parsed.data.endCondition ?? current.endCondition;
      const scheduleChanged = schedule !== null && scheduleIdentity(schedule) !== scheduleIdentity(currentSchedule);
      const endConditionChanged =
        parsed.data.endCondition !== undefined &&
        (parsed.data.endCondition.type !== current.endCondition.type ||
          (parsed.data.endCondition.type === 'on_date' &&
            current.endCondition.type === 'on_date' &&
            parsed.data.endCondition.date !== current.endCondition.date) ||
          (parsed.data.endCondition.type === 'after_runs' &&
            current.endCondition.type === 'after_runs' &&
            parsed.data.endCondition.runs !== current.endCondition.runs));
      const enabledChanged = parsed.data.enabled !== undefined && parsed.data.enabled !== current.enabled;
      const now = new Date();
      const endConditionReached = isTaskEndConditionReached(endCondition, {
        timezone: effectiveSchedule.timezone,
        scheduledRunCount: current.scheduledRunCount,
        now,
      });
      // Re-resolve one-off occurrence exhaustion when a schedule or enabled state
      // changes, and when editing the end condition of an already completed task.
      const resolveOccurrence = scheduleChanged || enabledChanged || (endConditionChanged && current.completedAt !== null);
      const resolvedNextRunAt = resolveOccurrence ? nextOccurrence(effectiveSchedule, now) : undefined;
      const scheduleExhausted = resolveOccurrence && resolvedNextRunAt === null;
      const requestedEnabled = parsed.data.enabled ?? current.enabled;
      const pendingOccurrence = resolveOccurrence ? resolvedNextRunAt : current.nextRunAt;
      // An expired date condition must not discard a scheduled occurrence that
      // is still inside its inclusive local-date window. The scheduler will
      // catch it up; paused or explicitly disabled tasks still complete here.
      const dateCatchUpPending =
        endCondition.type === 'on_date' &&
        endConditionReached &&
        current.enabled &&
        requestedEnabled &&
        current.completedAt === null &&
        pendingOccurrence !== null &&
        pendingOccurrence !== undefined &&
        !isAfterTaskEndDate(endCondition, effectiveSchedule.timezone, pendingOccurrence);
      const completeFromEndCondition = endConditionReached && !dateCatchUpPending;
      const enabled = completeFromEndCondition || scheduleExhausted ? false : requestedEnabled;
      // A title-only PATCH must not resume a paused task or re-book an existing occurrence.
      const nextRunAt = !enabled
        ? null
        : resolveOccurrence
          ? resolvedNextRunAt
          : undefined;
      const completedAt = completeFromEndCondition || scheduleExhausted
        ? current.completedAt ?? now
        : current.completedAt && (scheduleChanged || endConditionChanged || enabledChanged)
          ? null
          : current.completedAt;

      const [row] = await tx
        .update(tasks)
        .set({
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
          ...(parsed.data.systemInstructions !== undefined ? { systemInstructions: parsed.data.systemInstructions } : {}),
          ...(parsed.data.providerId ? { providerId: parsed.data.providerId } : {}),
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
          ...(parsed.data.allowWebResearch !== undefined ? { allowWebResearch: parsed.data.allowWebResearch } : {}),
          ...(parsed.data.notification ? { notification: parsed.data.notification } : {}),
          ...(parsed.data.memorySettings ? { memorySettings: parsed.data.memorySettings } : {}),
          ...(schedule ? { schedule, timezone: schedule.timezone } : {}),
          ...(parsed.data.endCondition !== undefined ? { endCondition } : {}),
          enabled,
          completedAt,
          ...(nextRunAt !== undefined ? { nextRunAt } : {}),
          updatedAt: now,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .returning();
      return row;
    });
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.taskUpdated, targetType: 'task', targetId: request.params.id });
    return omitTaskLimits(updated);
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
    return omitTaskLimits(updated);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .limit(1)
        .for('update');
      const task = rows[0];
      if (!task) throw AppError.notFound('task');
      const now = new Date();
      const schedule = scheduleSchema.parse(task.schedule);
      const reached = isTaskEndConditionReached(task.endCondition, {
        timezone: schedule.timezone,
        scheduledRunCount: task.scheduledRunCount,
        now,
      });
      const next = reached ? null : nextOccurrence(schedule, now);
      const completed = reached || next === null;
      const [row] = await tx
        .update(tasks)
        .set({
          enabled: !completed,
          nextRunAt: completed ? null : next,
          completedAt: completed ? task.completedAt ?? now : null,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.ownerId, me.id)))
        .returning();
      return row;
    });
    return omitTaskLimits(updated);
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
        limits: AGENT_RUNTIME_LIMITS,
        title: `${task.title} (copy)`,
        enabled: false,
        scheduledRunCount: 0,
        completedAt: null,
        nextRunAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    reply.code(201);
    return omitTaskLimits(copy);
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
