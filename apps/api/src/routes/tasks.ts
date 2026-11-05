import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { executionSteps, executions, providerCredentials, providerModels, providers, tasks } from '@agent-tasks/database';
import {
  AppError,
  AGENT_RUNTIME_LIMITS,
  catalogModelFor,
  isAfterTaskEndDate,
  isExecutableProviderKind,
  isTaskEndConditionReached,
  mergeProviderCatalog,
  monthlyDays,
  nextOccurrence,
  parseMemorySettings,
  scheduleSchema,
  taskInputSchema,
  taskFollowUpSchema,
  taskUpdateSchema,
  taskRequiresTools,
  describeSchedule,
  escapeMarkdownText,
  reportToMarkdown,
  truncateUtf8,
  CONVERSATION_DISPLAY_MAX_BYTES,
} from '@agent-tasks/shared';
import type { ExecutionReport, ParsedSchedule } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { requireUser, requireUuid } from '../lib/session.js';
import { enqueueExecution } from '../lib/queue.js';

interface PageCursor {
  createdAt: string;
  id: string;
}

const CURSOR_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;
const CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodePageCursor(value: string | undefined): PageCursor | undefined {
  if (value === undefined) return undefined;
  const invalid = () => AppError.badRequest('invalid pagination cursor');
  if (!value || value.length > 512) throw invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const cursor = parsed as Record<string, unknown>;
  if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') throw invalid();
  if (!CURSOR_UUID_PATTERN.test(cursor.id)) throw invalid();
  const timestamp = CURSOR_TIMESTAMP_PATTERN.exec(cursor.createdAt);
  const parsedTimestamp = Date.parse(`${cursor.createdAt.slice(0, 23)}Z`);
  if (
    !timestamp ||
    Number.isNaN(parsedTimestamp) ||
    new Date(parsedTimestamp).toISOString().slice(0, 19) !== timestamp[1]
  ) {
    throw invalid();
  }
  return { createdAt: cursor.createdAt, id: cursor.id };
}

function cursorPageLimit(value: string | undefined, fallback: number): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw AppError.badRequest('invalid pagination limit');
  }
  return limit;
}

function cursorPaginationEnabled(pagination: string | undefined, cursor: string | undefined): boolean {
  if (pagination !== undefined && pagination !== 'cursor') throw AppError.badRequest('invalid pagination mode');
  if (cursor !== undefined && pagination !== 'cursor') throw AppError.badRequest('cursor requires cursor pagination');
  return pagination === 'cursor';
}

/**
 * Legacy offsets use the same integer bounds as cursor pagination but keep the
 * historical default and clamp larger requests to the page-size ceiling.
 * A missing value stays valid, so old clients keep their response shape.
 */
function legacyPageLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw AppError.badRequest('invalid pagination limit');
  }
  return Math.min(limit, 100);
}

/** A malformed `before` timestamp must be a client error, not a database cast failure. */
function parseBeforeTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw AppError.badRequest('invalid pagination timestamp');
  const date = new Date(timestamp);
  // Date.parse normalizes impossible ISO calendar days (for example February 31)
  // into the following month. Reject those instead of silently changing the bound.
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (isoDate) {
    const [, year, month, day] = isoDate;
    if (
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day)
    ) {
      throw AppError.badRequest('invalid pagination timestamp');
    }
  }
  return date;
}

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

export function omitTaskLimits<T extends { limits: unknown }>(task: T): Omit<T, 'limits'>;
export function omitTaskLimits<T extends { limits: unknown }>(task: T | undefined): Omit<T, 'limits'> | undefined;
export function omitTaskLimits<T extends { limits: unknown }>(task: T | undefined): Omit<T, 'limits'> | undefined {
  if (!task) return undefined;
  const { limits, ...response } = task;
  void limits;
  return response;
}

interface TaskProvider {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
}

interface TaskToolRequirements {
  allowWebResearch: boolean;
  notification: string;
  memoryMode: string;
}

type DatabaseReader = Pick<AppContext['db'], 'select'>;

async function loadTaskProvider(db: DatabaseReader, providerId: string): Promise<TaskProvider> {
  const rows = await db
    .select({ id: providers.id, kind: providers.kind, name: providers.name, enabled: providers.enabled, config: providers.config })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  const provider = rows[0];
  if (!provider) throw AppError.badRequest('unknown provider');
  if (!provider.enabled) throw AppError.badRequest('provider is disabled');
  if (!isExecutableProviderKind(provider.kind)) {
    throw AppError.badRequest(
      `provider kind ${provider.kind} is not supported for task execution; create an openai-compatible provider instead`,
    );
  }
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    config: provider.config as Record<string, unknown>,
  };
}

async function assertProviderUsable(db: DatabaseReader, userId: string, providerId: string): Promise<TaskProvider> {
  const provider = await loadTaskProvider(db, providerId);
  const credentials = await db
    .select({ ownerId: providerCredentials.ownerId })
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, providerId));
  const usable = credentials.some((credential) => credential.ownerId === null || credential.ownerId === userId);
  if (!usable) throw AppError.badRequest('no usable credential for this provider');
  return provider;
}

/**
 * Validate everything the worker will rely on: an executable provider kind, a
 * credential, a catalog entry for the selected model, and an explicit tool
 * capability when the task asks for research or memory. Refusing here gives the
 * user an actionable response instead of a failed execution later. A completion
 * e-mail does not need model tools: the worker sends it itself.
 */
export async function assertTaskExecutable(
  db: DatabaseReader,
  userId: string,
  providerId: string,
  model: string,
  requirements: TaskToolRequirements,
): Promise<TaskProvider> {
  const provider = await assertProviderUsable(db, userId, providerId);
  const discovered = await db
    .select({
      id: providerModels.modelId,
      label: providerModels.label,
      supportsTools: providerModels.supportsTools,
      contextLength: providerModels.contextLength,
    })
    .from(providerModels)
    .where(eq(providerModels.providerId, providerId));
  const catalog = mergeProviderCatalog((provider.config as { models?: unknown }).models, discovered.map((entry) => ({
    id: entry.id,
    label: entry.label,
    supportsTools: entry.supportsTools,
    ...(entry.contextLength !== null ? { contextLength: entry.contextLength } : {}),
  })));
  const selected = catalogModelFor(catalog, model);
  if (!selected) {
    throw AppError.badRequest(`model ${model} is not in the provider catalog; refresh models or declare it on the provider`);
  }
  if (taskRequiresTools({
    allowWebResearch: requirements.allowWebResearch,
    memoryMode: requirements.memoryMode,
  }) && selected.supportsTools !== true) {
    throw AppError.badRequest(
      `model ${model} is not marked tool-capable on provider ${provider.name}; enable tools for it in the admin provider catalog or disable research and memory`,
    );
  }
  return provider;
}

export async function registerTaskRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  app.get<{ Querystring: { limit?: string; status?: string; pagination?: string; cursor?: string } }>('/api/tasks', async (request) => {
    const me = await requireUser(context, request);
    const status = request.query.status;
    if (status && !['active', 'paused', 'completed'].includes(status)) {
      throw AppError.badRequest('invalid task status filter');
    }
    const cursorPagination = cursorPaginationEnabled(request.query.pagination, request.query.cursor);
    const cursor = cursorPagination ? decodePageCursor(request.query.cursor) : undefined;
    const limit = cursorPagination ? cursorPageLimit(request.query.limit, 50) : legacyPageLimit(request.query.limit, 50);
    const conditions = [eq(tasks.ownerId, me.id)];
    if (status === 'active') conditions.push(eq(tasks.enabled, true), isNull(tasks.completedAt));
    if (status === 'paused') conditions.push(eq(tasks.enabled, false), isNull(tasks.completedAt));
    if (status === 'completed') conditions.push(isNotNull(tasks.completedAt));
    if (cursor) {
      conditions.push(
        sql`(${tasks.createdAt}, ${tasks.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await db
      .select({
        task: tasks,
        cursorCreatedAt: sql<string>`to_char(${tasks.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(cursorPagination ? limit + 1 : limit);
    const hasMore = cursorPagination && rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const unreadCounts = new Map<string, number>();
    if (pageRows.length > 0) {
      const counts = await db
        .select({ taskId: executions.taskId, count: sql<number>`count(*)::int` })
        .from(executions)
        .where(
          and(
            eq(executions.ownerId, me.id),
            inArray(executions.taskId, pageRows.map((row) => row.task.id)),
            eq(executions.status, 'completed'),
            isNull(executions.readAt),
          ),
        )
        .groupBy(executions.taskId);
      for (const count of counts) unreadCounts.set(count.taskId, Number(count.count));
    }
    const items = pageRows.map(({ task }) => ({
      ...omitTaskLimits(task),
      status: task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused',
      unreadCount: unreadCounts.get(task.id) ?? 0,
      scheduleDescription: describeSchedule(scheduleSchema.parse(task.schedule)),
    }));
    if (!cursorPagination) return items;
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodePageCursor({ createdAt: last.cursorCreatedAt, id: last.task.id }) : null,
    };
  });

  app.post<{ Body: unknown }>('/api/tasks', async (request, reply) => {
    const me = await requireUser(context, request);
    const parsed = taskInputSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid task', parsed.error.issues);
    const provider = await assertTaskExecutable(db, me.id, parsed.data.providerId, parsed.data.model, {
      allowWebResearch: parsed.data.allowWebResearch,
      notification: parsed.data.notification,
      memoryMode: parsed.data.memorySettings.mode,
    });
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
        // Keep hard ceilings in the legacy column for compatibility. The worker
        // resolves effective run budgets from administrator settings and clamps them
        // to the same hard ceilings.
        limits: AGENT_RUNTIME_LIMITS,
        allowWebResearch: parsed.data.allowWebResearch,
        notification: parsed.data.notification,
        memorySettings: parsed.data.memorySettings,
        conversationMode: parsed.data.conversationMode,
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
    // A title-only edit must stay possible even when the provider or capability was
    // later changed. Validate only fields that affect execution, against the effective
    // provider/model of the resulting task.
    const executionFieldsChanged =
      parsed.data.providerId !== undefined ||
      parsed.data.model !== undefined ||
      parsed.data.allowWebResearch !== undefined ||
      parsed.data.notification !== undefined ||
      parsed.data.memorySettings !== undefined;
    if (executionFieldsChanged) {
      const existing = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .limit(1);
      const current = existing[0];
      if (!current) throw AppError.notFound('task');
      await assertTaskExecutable(
        db,
        me.id,
        parsed.data.providerId ?? current.providerId,
        parsed.data.model ?? current.model,
        {
          allowWebResearch: parsed.data.allowWebResearch ?? current.allowWebResearch,
          notification: parsed.data.notification ?? current.notification,
          memoryMode: parseMemorySettings(parsed.data.memorySettings ?? current.memorySettings).mode,
        },
      );
    }
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
          ...(parsed.data.conversationMode ? { conversationMode: parsed.data.conversationMode } : {}),
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
      // Enabling a task schedules runs; refuse one the worker could never execute.
      if (!completed) {
        await assertTaskExecutable(tx, me.id, task.providerId, task.model, {
          allowWebResearch: task.allowWebResearch,
          notification: task.notification,
          memoryMode: parseMemorySettings(task.memorySettings).mode,
        });
      }
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
    const executionId = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .limit(1)
        .for('update');
      const task = rows[0];
      if (!task) throw AppError.notFound('task');
      // A manual run must not queue an execution the worker will refuse.
      await assertTaskExecutable(tx, me.id, task.providerId, task.model, {
        allowWebResearch: task.allowWebResearch,
        notification: task.notification,
        memoryMode: parseMemorySettings(task.memorySettings).mode,
      });
      const active = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.taskId, task.id), inArray(executions.status, ['queued', 'running'])))
        .limit(1);
      if (active.length > 0) throw AppError.conflict('this task already has a queued or running execution');

      const id = randomUUID();
      await tx.insert(executions).values({
        id,
        taskId: task.id,
        ownerId: me.id,
        taskTitle: task.title,
        inputSnapshot: task.prompt,
        status: 'queued',
        trigger: 'manual',
        providerId: task.providerId,
        model: task.model,
      });
      return id;
    });
    await enqueueExecution(context.env.DATABASE_URL, executionId);
    return { executionId };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/tasks/:id/follow-up', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const parsed = taskFollowUpSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid follow-up message', parsed.error.issues);

    const executionId = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
        .limit(1)
        .for('update');
      const task = rows[0];
      if (!task) throw AppError.notFound('task');
      if (task.conversationMode !== 'conversation') throw AppError.conflict('this task is not conversation-enabled');
      if (!task.enabled || task.completedAt) throw AppError.conflict('follow-ups require an enabled, incomplete task');
      await assertTaskExecutable(tx, me.id, task.providerId, task.model, {
        allowWebResearch: task.allowWebResearch,
        notification: task.notification,
        memoryMode: parseMemorySettings(task.memorySettings).mode,
      });
      const active = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.taskId, task.id), inArray(executions.status, ['queued', 'running'])))
        .limit(1);
      if (active.length > 0) throw AppError.conflict('this task already has a queued or running execution');

      const id = randomUUID();
      await tx.insert(executions).values({
        id,
        taskId: task.id,
        ownerId: me.id,
        taskTitle: task.title,
        inputSnapshot: parsed.data.message,
        status: 'queued',
        trigger: 'manual',
        providerId: task.providerId,
        model: task.model,
      });
      return id;
    });
    await enqueueExecution(context.env.DATABASE_URL, executionId);
    return { executionId };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/conversation', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const taskRows = await db
      .select({ id: tasks.id, conversationMode: tasks.conversationMode })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    const task = taskRows[0];
    if (!task) throw AppError.notFound('task');
    if (task.conversationMode !== 'conversation') throw AppError.conflict('this task is not conversation-enabled');

    const rows = await db
      .select({
        id: executions.id,
        status: executions.status,
        trigger: executions.trigger,
        input: executions.inputSnapshot,
        report: executions.report,
        createdAt: executions.createdAt,
        finishedAt: executions.finishedAt,
        error: executions.error,
      })
      .from(executions)
      .where(and(eq(executions.taskId, taskId), eq(executions.ownerId, me.id)))
      .orderBy(desc(executions.createdAt), desc(executions.id))
      .limit(20);
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        trigger: row.trigger,
        input: row.input,
        assistantOutput:
          typeof row.report === 'object' && row.report !== null && 'markdown' in row.report && typeof row.report.markdown === 'string'
            ? truncateUtf8(row.report.markdown, CONVERSATION_DISPLAY_MAX_BYTES)
            : null,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        error: row.error,
      })),
    };
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
    // Release a deliberate copy only if the worker could actually run it later.
    await assertTaskExecutable(db, me.id, task.providerId, task.model, {
      allowWebResearch: task.allowWebResearch,
      notification: task.notification,
      memoryMode: parseMemorySettings(task.memorySettings).mode,
    });
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

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string; pagination?: string; cursor?: string };
  }>('/api/tasks/:id/executions', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, me.id)))
      .limit(1);
    if (!taskRows[0]) throw AppError.notFound('task');
    const cursorPagination = cursorPaginationEnabled(request.query.pagination, request.query.cursor);
    if (cursorPagination && request.query.before !== undefined) {
      throw AppError.badRequest('before cannot be combined with cursor pagination');
    }
    const cursor = cursorPagination ? decodePageCursor(request.query.cursor) : undefined;
    const limit = cursorPagination ? cursorPageLimit(request.query.limit, 20) : legacyPageLimit(request.query.limit, 20);
    const before = parseBeforeTimestamp(request.query.before);
    const conditions = [eq(executions.taskId, taskId), eq(executions.ownerId, me.id)];
    if (before) conditions.push(lt(executions.createdAt, before));
    if (cursor) {
      conditions.push(
        sql`(${executions.createdAt}, ${executions.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
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
        readAt: executions.readAt,
        createdAt: executions.createdAt,
        cursorCreatedAt: sql<string>`to_char(${executions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(executions)
      .where(and(...conditions))
      .orderBy(desc(executions.createdAt), desc(executions.id))
      .limit(cursorPagination ? limit + 1 : limit);
    const hasMore = cursorPagination && rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    if (!cursorPagination) {
      return pageRows.map(({ createdAt: _createdAt, cursorCreatedAt: _cursorCreatedAt, ...row }) => row);
    }
    const items = pageRows.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodePageCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
    };
  });

  app.get<{ Querystring: { limit?: string; status?: string } }>('/api/executions', async (request) => {
    const me = await requireUser(context, request);
    const limit = legacyPageLimit(request.query.limit, 25);
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
        readAt: executions.readAt,
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
      .from(executionSteps)
      .where(eq(executionSteps.executionId, execution.id))
      .orderBy(executionSteps.step);
    return { ...execution, steps };
  });

  app.post<{ Params: { id: string } }>('/api/executions/:id/read', async (request) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select({ status: executions.status, readAt: executions.readAt })
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const execution = rows[0];
    if (!execution) throw AppError.notFound('execution');
    if (execution.status !== 'completed') throw AppError.conflict('only completed executions can be marked read');

    const [updated] = await db
      .update(executions)
      .set({ readAt: sql`coalesce(${executions.readAt}, now())` })
      .where(
        and(
          eq(executions.id, executionId),
          eq(executions.ownerId, me.id),
          eq(executions.status, 'completed'),
        ),
      )
      .returning({ readAt: executions.readAt });
    if (!updated?.readAt) throw AppError.conflict('only completed executions can be marked read');
    return { readAt: updated.readAt };
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
    const id = await db.transaction(async (tx) => {
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, previous.taskId), eq(tasks.ownerId, me.id)))
        .limit(1)
        .for('update');
      const task = taskRows[0];
      if (!task) throw AppError.notFound('task');
      const active = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.taskId, task.id), inArray(executions.status, ['queued', 'running'])))
        .limit(1);
      if (active.length > 0) throw AppError.conflict('this task already has a queued or running execution');
      // A retry must not queue an execution the worker will refuse.
      await assertTaskExecutable(tx, me.id, task.providerId, task.model, {
        allowWebResearch: task.allowWebResearch,
        notification: task.notification,
        memoryMode: parseMemorySettings(task.memorySettings).mode,
      });
      const retryId = randomUUID();
      await tx.insert(executions).values({
        id: retryId,
        taskId: task.id,
        ownerId: me.id,
        taskTitle: task.title,
        inputSnapshot: previous.inputSnapshot || task.prompt,
        status: 'queued',
        trigger: 'retry',
        attempt: previous.attempt + 1,
        providerId: task.providerId,
        model: task.model,
      });
      return retryId;
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
    const report = execution.report as ExecutionReport | null;
    if (format === 'json') {
      // The export is the durable record: it must carry the same timeline and
      // failure detail the detail view shows, not only the final text.
      const steps = await db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, execution.id))
        .orderBy(executionSteps.step);
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', `attachment; filename="${safeName}.json"`);
      return {
        id: execution.id,
        taskId: execution.taskId,
        taskTitle: execution.taskTitle,
        status: execution.status,
        trigger: execution.trigger,
        attempt: execution.attempt,
        providerName: execution.providerName,
        model: execution.model,
        scheduledFor: execution.scheduledFor,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        durationMs: execution.durationMs,
        error: execution.error,
        report,
        usage: execution.usage,
        steps,
      };
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${safeName}.md"`);
    if (!report) return [`# ${escapeMarkdownText(execution.taskTitle)}`, '', '_no report_'].join('\n');
    const rendered = reportToMarkdown(report, { title: execution.taskTitle, finishedAt: execution.finishedAt?.toISOString() ?? null });
    const rawSummary = report.summary.trim();
    if (rawSummary.length === 0 || rawSummary === report.markdown.trim()) return rendered;
    // The summary is stored separately from the checked report body, so it needs
    // the same Markdown escaping before it can enter the export.
    const summary = escapeMarkdownText(rawSummary);
    // reportToMarkdown renders the body first; insert the summary directly below
    // the header block so the export starts with the short answer.
    const headerEnd = rendered.indexOf('\n\n');
    if (headerEnd === -1) return `${rendered}\n\n## Summary\n\n${summary}`;
    return `${rendered.slice(0, headerEnd + 2)}## Summary\n\n${summary}\n\n${rendered.slice(headerEnd + 2)}`;
  });
}
