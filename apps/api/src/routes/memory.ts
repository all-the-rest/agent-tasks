import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  countMemories,
  createMemory,
  deleteAllMemories,
  deleteMemory,
  executions,
  exportMemories,
  findDuplicateMemoriesForOwner,
  findMemoriesByPrefix,
  getMemory,
  listMemoryChanges,
  listMemoryRevisions,
  listMemorySuggestions,
  listMemories,
  listRecommendationEvents,
  listRecommendations,
  reviewMemorySuggestion,
  setRecommendationStatus,
  updateMemory,
} from '@agent-tasks/database';
import type { MemoryRow } from '@agent-tasks/database';
import {
  AppError,
  memoryCreateSchema,
  memoryListQuerySchema,
  memoryUpdateSchema,
  parseMemoryCommand,
  recommendationStatusSchema,
} from '@agent-tasks/shared';
import type { DuplicateMatch, MemoryCommand, MemoryScope } from '@agent-tasks/shared';
import type { AppContext } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { assertTaskOwner, requireUser, requireUuid } from '../lib/session.js';

interface CommandBody {
  input?: unknown;
  taskId?: unknown;
  confirm?: unknown;
}

function candidate(match: DuplicateMatch) {
  return {
    id: match.memory.id,
    scope: match.memory.scope,
    taskId: match.memory.taskId,
    category: match.memory.category,
    content: match.memory.content,
    semanticKey: match.memory.semanticKey,
    score: match.score,
    reason: match.reason,
    updatedAt: new Date(match.memory.updatedAt).toISOString(),
  };
}

function memorySummary(memory: {
  id: string;
  scope: string;
  taskId: string | null;
  category: string;
  content: string;
  semanticKey: string | null;
  updatedAt: Date;
}) {
  return {
    id: memory.id,
    scope: memory.scope,
    taskId: memory.taskId,
    category: memory.category,
    content: memory.content,
    semanticKey: memory.semanticKey,
    updatedAt: memory.updatedAt,
  };
}

async function resolveMemoryReference(
  context: AppContext,
  ownerId: string,
  reference: string,
  scope?: MemoryScope,
): Promise<MemoryRow | null> {
  if (reference.length !== 36) return null;
  const exact = await getMemory(context.db, ownerId, reference);
  if (!exact) return null;
  if (scope && exact.scope !== scope) throw AppError.notFound(`memory in ${scope} scope`);
  return exact;
}

export async function registerMemoryRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  const assertTaskIfPresent = async (ownerId: string, taskId: string | undefined): Promise<string | null> => {
    if (!taskId) return null;
    await assertTaskOwner(context, ownerId, taskId);
    return taskId;
  };

  app.get<{ Querystring: Record<string, string> }>('/api/memory', async (request) => {
    const me = await requireUser(context, request);
    const parsed = memoryListQuerySchema.safeParse(request.query);
    if (!parsed.success) throw AppError.badRequest('invalid memory query', parsed.error.issues);
    const { scope, taskId, category, q, limit, offset } = parsed.data;
    if (scope === 'global' && taskId) throw AppError.badRequest('global memory cannot be filtered by taskId');
    if (taskId) await assertTaskIfPresent(me.id, taskId);
    return listMemories(db, me.id, { scope, taskId, category, q, limit, offset });
  });

  app.get('/api/memory/export', async (request, reply) => {
    const me = await requireUser(context, request);
    const payload = await exportMemories(db, me.id);
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memoryExported,
      targetType: 'memory',
      metadata: { memories: payload.memories.length, recommendations: payload.recommendations.length },
      ip: request.ip,
    });
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="agent-tasks-memory-${new Date().toISOString().slice(0, 10)}.json"`);
    return payload;
  });

  app.get('/api/memory/stats', async (request) => {
    const me = await requireUser(context, request);
    const [global, task] = await Promise.all([
      countMemories(db, me.id, { scope: 'global' }),
      countMemories(db, me.id, { scope: 'task' }),
    ]);
    return { global, task, total: global + task };
  });

  app.get<{ Params: { id: string } }>('/api/memory/:id/revisions', async (request) => {
    const me = await requireUser(context, request);
    const memoryId = requireUuid(request.params.id, 'memory');
    return listMemoryRevisions(db, me.id, memoryId);
  });

  app.get<{ Params: { id: string } }>('/api/memory/:id', async (request) => {
    const me = await requireUser(context, request);
    const memoryId = requireUuid(request.params.id, 'memory');
    const memory = await getMemory(db, me.id, memoryId);
    if (!memory) throw AppError.notFound('memory');
    return memory;
  });

  app.post<{ Body: unknown }>('/api/memory', async (request, reply) => {
    const me = await requireUser(context, request);
    const parsed = memoryCreateSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid memory', parsed.error.issues);
    if (parsed.data.scope === 'task') await assertTaskIfPresent(me.id, parsed.data.taskId);
    const created = await createMemory(db, {
      ownerId: me.id,
      scope: parsed.data.scope,
      taskId: parsed.data.scope === 'task' ? parsed.data.taskId : null,
      category: parsed.data.category,
      content: parsed.data.content,
      semanticKey: parsed.data.semanticKey ?? null,
      origin: 'user',
    });
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memoryCreated,
      targetType: 'memory',
      targetId: created.id,
      metadata: { scope: created.scope, category: created.category, taskId: created.taskId },
      ip: request.ip,
    });
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/memory/:id', async (request) => {
    const me = await requireUser(context, request);
    const memoryId = requireUuid(request.params.id, 'memory');
    const parsed = memoryUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.badRequest('invalid memory update', parsed.error.issues);
    const updated = await updateMemory(db, {
      ownerId: me.id,
      memoryId,
      content: parsed.data.content,
      category: parsed.data.category,
      semanticKey: parsed.data.semanticKey,
    });
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memoryUpdated,
      targetType: 'memory',
      targetId: updated.id,
      metadata: { scope: updated.scope, category: updated.category, revision: updated.revision },
      ip: request.ip,
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    const me = await requireUser(context, request);
    const memoryId = requireUuid(request.params.id, 'memory');
    const deleted = await deleteMemory(db, me.id, memoryId);
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memoryDeleted,
      targetType: 'memory',
      targetId: deleted.id,
      // Deliberately no content: deleted memories must not persist in audit logs.
      metadata: { scope: deleted.scope, category: deleted.category, taskId: deleted.taskId },
      ip: request.ip,
    });
    reply.code(204);
    return null;
  });

  app.post<{ Body: { scope?: unknown; taskId?: unknown; confirm?: unknown } }>('/api/memory/delete-all', async (request) => {
    const me = await requireUser(context, request);
    if (request.body?.confirm !== true) throw AppError.badRequest('explicit confirmation is required to delete memories');
    const scope = request.body.scope;
    if (scope !== 'all' && scope !== 'global' && scope !== 'task') throw AppError.badRequest('scope must be all, global or task');
    const taskId = typeof request.body.taskId === 'string' ? request.body.taskId : undefined;
    if (scope === 'all' && taskId) throw AppError.badRequest('taskId is only valid with task scope');
    if (scope === 'task') {
      if (!taskId) throw AppError.badRequest('task scope requires a taskId');
      await assertTaskIfPresent(me.id, taskId);
    }
    const removed = await deleteAllMemories(db, me.id, {
      scope: scope === 'all' ? undefined : scope,
      taskId,
    });
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memoryDeleted,
      targetType: 'memory',
      metadata: { scope, count: removed, taskId: taskId ?? null },
      ip: request.ip,
    });
    return { deleted: removed };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/memory-changes', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskIfPresent(me.id, taskId);
    return listMemoryChanges(db, me.id, { taskId });
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/memory-suggestions', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskIfPresent(me.id, taskId);
    return listMemorySuggestions(db, me.id, { taskId });
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/recommendations', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskIfPresent(me.id, taskId);
    return listRecommendations(db, me.id, { taskId });
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/recommendation-events', async (request) => {
    const me = await requireUser(context, request);
    const taskId = requireUuid(request.params.id, 'task');
    await assertTaskIfPresent(me.id, taskId);
    return listRecommendationEvents(db, me.id, { taskId });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/recommendations/:id', async (request) => {
    const me = await requireUser(context, request);
    const id = requireUuid(request.params.id, 'recommendation');
    const parsed = recommendationStatusSchema.safeParse((request.body as { status?: unknown } | null)?.status);
    if (!parsed.success) throw AppError.badRequest('invalid recommendation status');
    const updated = await setRecommendationStatus(db, me.id, id, parsed.data);
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.recommendationStatusChanged,
      targetType: 'recommendation',
      targetId: id,
      metadata: { status: parsed.data, taskId: updated.taskId },
      ip: request.ip,
    });
    return updated;
  });

  app.post<{ Params: { id: string } }>('/api/memory-suggestions/:id/accept', async (request) => {
    const me = await requireUser(context, request);
    const id = requireUuid(request.params.id, 'memory suggestion');
    const memory = await reviewMemorySuggestion(db, me.id, id, 'accept');
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memorySuggestionAccepted,
      targetType: 'memory',
      targetId: memory?.id ?? id,
      metadata: { suggestionId: id },
      ip: request.ip,
    });
    return { memory };
  });

  app.post<{ Params: { id: string } }>('/api/memory-suggestions/:id/reject', async (request) => {
    const me = await requireUser(context, request);
    const id = requireUuid(request.params.id, 'memory suggestion');
    await reviewMemorySuggestion(db, me.id, id, 'reject');
    await context.audit({
      actorId: me.id,
      action: AUDIT_ACTIONS.memorySuggestionRejected,
      targetType: 'memory suggestion',
      targetId: id,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/executions/:id/memory', async (request) => {
    const me = await requireUser(context, request);
    const executionId = requireUuid(request.params.id, 'execution');
    const rows = await db
      .select({ id: executions.id, taskId: executions.taskId })
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.ownerId, me.id)))
      .limit(1);
    const execution = rows[0];
    if (!execution) throw AppError.notFound('execution');
    const [changes, suggestions, recommendationEvents] = await Promise.all([
      listMemoryChanges(db, me.id, { executionId }),
      listMemorySuggestions(db, me.id, { taskId: execution.taskId }),
      listRecommendationEvents(db, me.id, { executionId }),
    ]);
    return { changes, suggestions: suggestions.filter((item) => item.executionId === executionId), recommendationEvents };
  });

  /**
   * Deterministic slash-command endpoint. Parsing is application code and every
   * branch performs the same owner-scoped queries as the regular API. `confirm`
   * is required for an actual `/forget` deletion.
   */
  app.post<{ Body: CommandBody }>('/api/memory/commands', async (request) => {
    const me = await requireUser(context, request);
    if (typeof request.body?.input !== 'string') throw AppError.badRequest('input is required');
    const command: MemoryCommand = parseMemoryCommand(request.body.input);
    if (command.kind === 'error') throw AppError.badRequest(command.message);

    const taskId = typeof request.body.taskId === 'string' ? request.body.taskId : undefined;

    switch (command.kind) {
      case 'learn': {
        if (command.scope === 'task' && !taskId) {
          throw AppError.badRequest('No task is selected. Open a task or select one before using /learn task.');
        }
        const scopedTaskId = command.scope === 'task' ? await assertTaskIfPresent(me.id, taskId) : null;
        const duplicates = await findDuplicateMemoriesForOwner(db, {
          ownerId: me.id,
          scope: command.scope,
          taskId: scopedTaskId,
          content: command.text,
        });
        if (duplicates.length > 0) {
          return {
            kind: 'duplicate',
            scope: command.scope,
            candidates: duplicates.map(candidate),
            message:
              'A similar memory already exists. Select it to replace its content, or rephrase the new memory if it is intentionally different.',
          };
        }
        const created = await createMemory(db, {
          ownerId: me.id,
          scope: command.scope,
          taskId: scopedTaskId,
          category: command.scope === 'global' ? 'instruction' : 'finding',
          content: command.text,
          origin: 'slash_command',
          originRef: request.body.input.slice(0, 200),
        });
        await context.audit({
          actorId: me.id,
          action: AUDIT_ACTIONS.memoryCreated,
          targetType: 'memory',
          targetId: created.id,
          metadata: { scope: created.scope, category: created.category, taskId: created.taskId, source: 'slash_command' },
          ip: request.ip,
        });
        return { kind: 'learned', memory: created };
      }
      case 'memory': {
        if (command.scope === 'task' && !taskId) {
          throw AppError.badRequest('No task is selected. Open a task before using /memory task.');
        }
        const scopedTaskId = command.scope === 'task' ? await assertTaskIfPresent(me.id, taskId) : null;
        if (command.scope === 'task') {
          const taskMemories = await listMemories(db, me.id, { scope: 'task', taskId: scopedTaskId ?? undefined, limit: 100 });
          return { kind: 'memory_list', scope: 'task', memories: taskMemories.items, total: taskMemories.total, taskId: scopedTaskId };
        }
        if (command.scope === 'global') {
          const globalMemories = await listMemories(db, me.id, { scope: 'global', limit: 100 });
          return { kind: 'memory_list', scope: 'global', memories: globalMemories.items, total: globalMemories.total };
        }
        const [globalMemories, taskMemories] = await Promise.all([
          listMemories(db, me.id, { scope: 'global', limit: 100 }),
          taskId
            ? listMemories(db, me.id, { scope: 'task', taskId, limit: 100 })
            : Promise.resolve({ items: [], total: 0 }),
        ]);
        if (taskId) await assertTaskIfPresent(me.id, taskId);
        return {
          kind: 'memory_list',
          scope: 'all',
          global: globalMemories.items,
          task: taskMemories.items,
          globalTotal: globalMemories.total,
          taskTotal: taskMemories.total,
          taskId: taskId ?? null,
        };
      }
      case 'update': {
        const exact = await resolveMemoryReference(context, me.id, command.id);
        if (!exact) {
          const prefixMatches = await findMemoriesByPrefix(db, me.id, command.id);
          if (prefixMatches.length > 1) {
            return {
              kind: 'ambiguous',
              message: 'Multiple memories match this id prefix. Select the exact memory.',
              candidates: prefixMatches.map((memory) => memorySummary(memory)),
            };
          }
          if (prefixMatches.length === 0) throw AppError.notFound('memory');
          const updated = await updateMemory(db, {
            ownerId: me.id,
            memoryId: prefixMatches[0]!.id,
            content: command.text,
            changedBy: 'slash_command',
          });
          await context.audit({
            actorId: me.id,
            action: AUDIT_ACTIONS.memoryUpdated,
            targetType: 'memory',
            targetId: updated.id,
            metadata: { scope: updated.scope, category: updated.category, revision: updated.revision, source: 'slash_command' },
            ip: request.ip,
          });
          return { kind: 'updated', memory: updated };
        }
        const updated = await updateMemory(db, {
          ownerId: me.id,
          memoryId: exact.id,
          content: command.text,
          changedBy: 'slash_command',
        });
        await context.audit({
          actorId: me.id,
          action: AUDIT_ACTIONS.memoryUpdated,
          targetType: 'memory',
          targetId: updated.id,
          metadata: { scope: updated.scope, category: updated.category, revision: updated.revision, source: 'slash_command' },
          ip: request.ip,
        });
        return { kind: 'updated', memory: updated };
      }
      case 'forget': {
        if (command.search) {
          const found = await listMemories(db, me.id, {
            scope: command.scope,
            q: command.search,
            limit: 20,
          });
          if (found.items.length === 0) throw AppError.notFound('memory');
          return {
            kind: 'forget_candidates',
            scope: command.scope ?? null,
            candidates: found.items.map((memory) => memorySummary(memory)),
            message: 'Select one memory and confirm deletion. Nothing has been deleted yet.',
          };
        }
        if (!command.id) throw AppError.badRequest('a memory id or search text is required');
        const exact = await resolveMemoryReference(context, me.id, command.id, command.scope);
        if (!exact) {
          const prefixMatches = await findMemoriesByPrefix(db, me.id, command.id, command.scope);
          if (prefixMatches.length > 1) {
            return {
              kind: 'ambiguous',
              message: 'Multiple memories match this id prefix. Select the exact memory.',
              candidates: prefixMatches.map((memory) => memorySummary(memory)),
            };
          }
          if (prefixMatches.length === 0) throw AppError.notFound('memory');
          const memory = prefixMatches[0]!;
          if (request.body?.confirm !== true) {
            return { kind: 'confirm_forget', memory: memorySummary(memory) };
          }
          const deleted = await deleteMemory(db, me.id, memory.id, 'slash_command');
          await context.audit({
            actorId: me.id,
            action: AUDIT_ACTIONS.memoryDeleted,
            targetType: 'memory',
            targetId: deleted.id,
            metadata: { scope: deleted.scope, category: deleted.category, taskId: deleted.taskId, source: 'slash_command' },
            ip: request.ip,
          });
          return { kind: 'forgotten', id: deleted.id, scope: deleted.scope, taskId: deleted.taskId };
        }
        if (request.body?.confirm !== true) {
          return { kind: 'confirm_forget', memory: memorySummary(exact) };
        }
        const deleted = await deleteMemory(db, me.id, exact.id, 'slash_command');
        await context.audit({
          actorId: me.id,
          action: AUDIT_ACTIONS.memoryDeleted,
          targetType: 'memory',
          targetId: deleted.id,
          metadata: { scope: deleted.scope, category: deleted.category, taskId: deleted.taskId, source: 'slash_command' },
          ip: request.ip,
        });
        return { kind: 'forgotten', id: deleted.id, scope: deleted.scope, taskId: deleted.taskId };
      }
      default:
        throw AppError.badRequest('unsupported command');
    }
  });
}
