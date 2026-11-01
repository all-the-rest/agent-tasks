import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  AppError,
  agentMemoryOpSchema,
  agentRecommendationOpSchema,
  detectMemorySecret,
  findDuplicateMemories,
  sanitizeMemoryContent,
  GLOBAL_MEMORY_CATEGORIES,
  TASK_MEMORY_CATEGORIES,
} from '@agent-tasks/shared';
import type {
  AgentMemoryOp,
  AgentRecommendationOp,
  DuplicateMatch,
  MemoryCandidate,
  MemoryCategory,
  MemoryLearningMode,
  MemoryOrigin,
  MemoryScope,
  RecommendationStatus,
} from '@agent-tasks/shared';
import type { Database } from './client.js';
import {
  memories,
  memoryChanges,
  memoryRevisions,
  memorySuggestions,
  memoryTombstones,
  recommendationEvents,
  recommendations,
  tasks,
} from './schema.js';

/** Bounded growth: users may still keep hundreds of records per scope. */
export const MAX_MEMORIES_PER_SCOPE = 1_000;
const MAX_REVISIONS_PER_MEMORY = 20;

export type MemoryRow = typeof memories.$inferSelect;
export type SuggestionRow = typeof memorySuggestions.$inferSelect;
export type RecommendationRow = typeof recommendations.$inferSelect;
export type MemoryChangeRow = typeof memoryChanges.$inferSelect;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function hashContent(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/** Links a memory back to the suggestion that created it, including older rows. */
function acceptedSuggestionIdFrom(provenance: unknown): string | null {
  if (!provenance || typeof provenance !== 'object') return null;
  const value = (provenance as Record<string, unknown>).acceptedSuggestionId;
  return typeof value === 'string' ? value : null;
}

function assertCategoryForScope(scope: MemoryScope, category: MemoryCategory): void {
  const allowed = scope === 'global' ? GLOBAL_MEMORY_CATEGORIES : TASK_MEMORY_CATEGORIES;
  if (!allowed.includes(category)) {
    throw AppError.badRequest(`category "${category}" is not valid for ${scope} memory`);
  }
}

function prepareContent(content: string): string {
  const sanitized = sanitizeMemoryContent(content);
  if (!sanitized) throw AppError.badRequest('memory content must not be empty');
  const secret = detectMemorySecret(sanitized);
  if (secret) throw AppError.badRequest(`memory content appears to contain a ${secret}; credentials are never stored as memory`);
  return sanitized;
}

async function lock(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

async function assertTaskOwned(tx: Transaction, ownerId: string, taskId: string): Promise<void> {
  const rows = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.ownerId, ownerId))).limit(1);
  if (!rows[0]) throw AppError.notFound('task');
}

async function insertRevision(
  tx: Transaction,
  input: {
    memoryId: string;
    revision: number;
    content: string;
    category: string;
    semanticKey: string | null;
    changedBy: string;
    executionId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(memoryRevisions).values({
    id: randomUUID(),
    memoryId: input.memoryId,
    revision: input.revision,
    content: input.content,
    category: input.category,
    semanticKey: input.semanticKey,
    metadata: input.metadata ?? {},
    changedBy: input.changedBy,
    executionId: input.executionId ?? null,
  });
  // Revision history is bounded; the current memory is never touched by pruning.
  await tx.execute(sql`
    delete from memory_revisions
    where memory_id = ${input.memoryId} and revision <= ${input.revision - MAX_REVISIONS_PER_MEMORY}
  `);
}

async function recordChange(
  tx: Transaction,
  input: {
    ownerId: string;
    taskId: string | null;
    memoryId: string | null;
    executionId?: string | null;
    suggestionId?: string | null;
    action: string;
    scope: MemoryScope;
    beforeContent?: string | null;
    afterContent?: string | null;
    summary?: string | null;
  },
): Promise<void> {
  await tx.insert(memoryChanges).values({
    id: randomUUID(),
    ownerId: input.ownerId,
    taskId: input.taskId,
    memoryId: input.memoryId,
    executionId: input.executionId ?? null,
    suggestionId: input.suggestionId ?? null,
    action: input.action,
    scope: input.scope,
    beforeContent: input.beforeContent ?? null,
    afterContent: input.afterContent ?? null,
    summary: input.summary ?? null,
  });
}

export interface CreateMemoryInput {
  ownerId: string;
  scope: MemoryScope;
  taskId?: string | null;
  category: MemoryCategory;
  content: string;
  semanticKey?: string | null;
  origin: MemoryOrigin;
  originRef?: string | null;
  provenance?: Record<string, unknown>;
  executionId?: string | null;
}

/** Explicit user (or command) creation. Conflicts are surfaced, never merged silently. */
export async function createMemory(db: Database, input: CreateMemoryInput): Promise<MemoryRow> {
  const content = prepareContent(input.content);
  assertCategoryForScope(input.scope, input.category);
  if (input.scope === 'task' && !input.taskId) throw AppError.badRequest('task memory requires a task');
  if (input.scope === 'global' && input.taskId) throw AppError.badRequest('global memory cannot be attached to a task');
  const semanticKey = input.semanticKey?.trim() || null;

  return db.transaction(async (tx) => {
    if (input.taskId) await assertTaskOwned(tx, input.ownerId, input.taskId);
    const contentHash = hashContent(content);
    await lock(tx, `memory-create:${input.ownerId}:${input.scope}:${input.taskId ?? ''}:${semanticKey ?? contentHash}`);

    if (semanticKey) {
      const existing = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.ownerId, input.ownerId),
            eq(memories.scope, input.scope),
            input.taskId ? eq(memories.taskId, input.taskId) : sql`${memories.taskId} is null`,
            eq(memories.semanticKey, semanticKey),
          ),
        )
        .limit(1);
      if (existing[0]) throw new AppError('conflict', 'a memory with this stable key already exists', 409, { memoryId: existing[0].id });
    }

    // Identical content in the same scope is a duplicate even without a key.
    const identical = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, input.ownerId),
          eq(memories.scope, input.scope),
          input.taskId ? eq(memories.taskId, input.taskId) : sql`${memories.taskId} is null`,
          eq(memories.content, content),
        ),
      )
      .limit(1);
    if (identical[0]) throw new AppError('conflict', 'an identical memory already exists', 409, { memoryId: identical[0].id });

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, input.ownerId),
          eq(memories.scope, input.scope),
          input.taskId ? eq(memories.taskId, input.taskId) : sql`${memories.taskId} is null`,
        ),
      );
    if (Number(countRows[0]?.count ?? 0) >= MAX_MEMORIES_PER_SCOPE) {
      throw AppError.limitExceeded(`memory limit reached (${MAX_MEMORIES_PER_SCOPE} per scope); delete memories first`);
    }

    const id = randomUUID();
    const [created] = await tx
      .insert(memories)
      .values({
        id,
        ownerId: input.ownerId,
        taskId: input.taskId ?? null,
        scope: input.scope,
        category: input.category,
        content,
        semanticKey,
        origin: input.origin,
        originRef: input.originRef ?? null,
        provenance: input.provenance ?? {},
        userEdited: input.origin === 'user' || input.origin === 'slash_command',
      })
      .returning();
    if (!created) throw new Error('memory insert returned no row');
    await insertRevision(tx, {
      memoryId: id,
      revision: 1,
      content,
      category: input.category,
      semanticKey,
      changedBy: input.origin,
      executionId: input.executionId,
    });
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId ?? null,
      memoryId: id,
      executionId: input.executionId,
      action: 'created',
      scope: input.scope,
      afterContent: content,
      summary: `created ${input.scope} ${input.category} memory`,
    });
    return created;
  });
}

export async function getMemory(db: Database, ownerId: string, memoryId: string): Promise<MemoryRow | null> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Revision history is owner-scoped and bounded; deleting a memory cascades it. */
export async function listMemoryRevisions(
  db: Database,
  ownerId: string,
  memoryId: string,
): Promise<Array<typeof memoryRevisions.$inferSelect>> {
  const memory = await getMemory(db, ownerId, memoryId);
  if (!memory) throw AppError.notFound('memory');
  return db
    .select()
    .from(memoryRevisions)
    .where(eq(memoryRevisions.memoryId, memoryId))
    .orderBy(desc(memoryRevisions.revision))
    .limit(MAX_REVISIONS_PER_MEMORY);
}

/** Prefix lookup supports the short IDs shown by `/memory`; ambiguity is explicit. */
export async function findMemoriesByPrefix(
  db: Database,
  ownerId: string,
  prefix: string,
  scope?: MemoryScope,
): Promise<MemoryRow[]> {
  const cleaned = prefix.trim().toLowerCase();
  if (cleaned.length < 4 || !/^[0-9a-f-]+$/.test(cleaned)) return [];
  const conditions = [eq(memories.ownerId, ownerId), sql`${memories.id}::text like ${`${cleaned}%`}`];
  if (scope) conditions.push(eq(memories.scope, scope));
  return db.select().from(memories).where(and(...conditions)).limit(10);
}

export interface UpdateMemoryInput {
  ownerId: string;
  memoryId: string;
  content?: string;
  category?: MemoryCategory;
  semanticKey?: string | null;
  changedBy?: string;
  executionId?: string | null;
}

export async function updateMemory(db: Database, input: UpdateMemoryInput): Promise<MemoryRow> {
  const changedBy = input.changedBy ?? 'user';
  const content = input.content !== undefined ? prepareContent(input.content) : undefined;
  return db.transaction(async (tx) => {
    await lock(tx, `memory-update:${input.memoryId}`);
    const rows = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, input.memoryId), eq(memories.ownerId, input.ownerId)))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (!existing) throw AppError.notFound('memory');

    const category = input.category ?? (existing.category as MemoryCategory);
    assertCategoryForScope(existing.scope as MemoryScope, category);
    const nextContent = content ?? existing.content;
    const nextSemanticKey = input.semanticKey !== undefined ? input.semanticKey?.trim() || null : existing.semanticKey;

    if (nextSemanticKey && nextSemanticKey !== existing.semanticKey) {
      await lock(tx, `memory-key:${input.ownerId}:${existing.scope}:${existing.taskId ?? ''}:${nextSemanticKey}`);
      const conflict = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.ownerId, input.ownerId),
            eq(memories.scope, existing.scope),
            existing.taskId ? eq(memories.taskId, existing.taskId) : sql`${memories.taskId} is null`,
            eq(memories.semanticKey, nextSemanticKey),
          ),
        )
        .limit(1);
      if (conflict[0] && conflict[0].id !== existing.id) {
        throw new AppError('conflict', 'another memory already uses this stable key', 409, { memoryId: conflict[0].id });
      }
    }

    const revision = existing.revision + 1;
    const [updated] = await tx
      .update(memories)
      .set({
        content: nextContent,
        category,
        semanticKey: nextSemanticKey,
        revision,
        userEdited: true,
        origin: changedBy === 'agent' ? existing.origin : changedBy === 'slash_command' ? 'slash_command' : 'user',
        updatedAt: new Date(),
      })
      .where(eq(memories.id, existing.id))
      .returning();
    if (!updated) throw new Error('memory update returned no row');
    await insertRevision(tx, {
      memoryId: existing.id,
      revision,
      content: nextContent,
      category,
      semanticKey: nextSemanticKey,
      changedBy,
      executionId: input.executionId,
    });
    // A pending automatic suggestion is obsolete once the user edited the record.
    await tx
      .update(memorySuggestions)
      .set({ status: 'rejected', reason: 'memory was edited by the user', reviewedAt: new Date() })
      .where(and(eq(memorySuggestions.targetMemoryId, existing.id), eq(memorySuggestions.status, 'pending')));
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: existing.taskId,
      memoryId: existing.id,
      executionId: input.executionId,
      action: 'updated',
      scope: existing.scope as MemoryScope,
      beforeContent: existing.content,
      afterContent: nextContent,
      summary: `user updated ${existing.scope} memory`,
    });
    return updated;
  });
}

async function deleteMemoryWithin(tx: Transaction, existing: MemoryRow, changedBy: string): Promise<void> {
  // Hash every revision, not only the current text: a previously agent-created
  // version must not be re-learned after the user edits and then forgets it.
  const revisions = await tx
    .select({ content: memoryRevisions.content })
    .from(memoryRevisions)
    .where(eq(memoryRevisions.memoryId, existing.id));
  const contentHashes = new Set([hashContent(existing.content), ...revisions.map((row) => hashContent(row.content))]);
  for (const contentHash of contentHashes) {
    await tx.insert(memoryTombstones).values({
      id: randomUUID(),
      ownerId: existing.ownerId,
      taskId: existing.taskId,
      scope: existing.scope,
      semanticKey: existing.semanticKey,
      contentHash,
      changedBy,
    });
  }

  /*
   * An accepted new-memory suggestion creates a memory but historically kept
   * `target_memory_id = null`. Find every affected suggestion first: linked by
   * target, linked by provenance, or pending for the same task with the same
   * stable key or text. Their `suggested` journal rows must be scrubbed too.
   */
  const acceptedSuggestionId = acceptedSuggestionIdFrom(existing.provenance);
  const texts = new Set([existing.content, ...revisions.map((row) => row.content)]);
  const suggestionRows = await tx
    .select({
      id: memorySuggestions.id,
      targetMemoryId: memorySuggestions.targetMemoryId,
      semanticKey: memorySuggestions.semanticKey,
      content: memorySuggestions.content,
    })
    .from(memorySuggestions)
    .where(
      or(
        eq(memorySuggestions.targetMemoryId, existing.id),
        ...(acceptedSuggestionId ? [eq(memorySuggestions.id, acceptedSuggestionId)] : []),
        ...(existing.taskId ? [eq(memorySuggestions.taskId, existing.taskId)] : []),
      ),
    );
  const affectedSuggestionIds = suggestionRows
    .filter(
      (row) =>
        row.targetMemoryId === existing.id ||
        row.id === acceptedSuggestionId ||
        (existing.taskId !== null &&
          ((existing.semanticKey !== null && row.semanticKey === existing.semanticKey) || texts.has(row.content))),
    )
    .map((row) => row.id);
  const suggestionFilter = affectedSuggestionIds.length > 0 ? inArray(memorySuggestions.id, affectedSuggestionIds) : null;

  // Audit transparency without retaining the forgotten text.
  const changeFilter = affectedSuggestionIds.length > 0
    ? or(eq(memoryChanges.memoryId, existing.id), inArray(memoryChanges.suggestionId, affectedSuggestionIds))
    : eq(memoryChanges.memoryId, existing.id);
  await tx
    .update(memoryChanges)
    .set({ memoryId: null, beforeContent: null, afterContent: null, summary: 'memory deleted by user' })
    .where(changeFilter);
  // Pending/accepted proposals must not keep showing content the user just forgot.
  if (suggestionFilter) {
    await tx
      .update(memorySuggestions)
      .set({ status: 'rejected', reason: 'target memory was deleted', content: '[deleted]', reviewedAt: new Date() })
      .where(suggestionFilter);
  }
  await recordChange(tx, {
    ownerId: existing.ownerId,
    taskId: existing.taskId,
    memoryId: null,
    action: 'deleted',
    scope: existing.scope as MemoryScope,
    summary: `user deleted ${existing.scope} ${existing.category} memory (${existing.id})`,
  });
  await tx.delete(memories).where(eq(memories.id, existing.id));
}

/** Physical deletion plus a content-free tombstone that blocks automatic resurrection. */
export async function deleteMemory(
  db: Database,
  ownerId: string,
  memoryId: string,
  changedBy = 'user',
): Promise<MemoryRow> {
  return db.transaction(async (tx) => {
    await lock(tx, `memory-delete:${memoryId}`);
    const rows = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, memoryId), eq(memories.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (!existing) throw AppError.notFound('memory');
    await deleteMemoryWithin(tx, existing, changedBy);
    return existing;
  });
}

/** Explicit "delete all" is still user-initiated and confirmed by the UI/API body. */
export async function deleteAllMemories(
  db: Database,
  ownerId: string,
  input: { scope?: MemoryScope; taskId?: string | null } = {},
): Promise<number> {
  const conditions = [eq(memories.ownerId, ownerId)];
  if (input.scope) conditions.push(eq(memories.scope, input.scope));
  if (input.taskId) conditions.push(eq(memories.taskId, input.taskId));
  const rows = await db.select({ id: memories.id }).from(memories).where(and(...conditions));
  for (const row of rows) await deleteMemory(db, ownerId, row.id, 'user');
  return rows.length;
}

export interface ListMemoryFilters {
  scope?: MemoryScope;
  taskId?: string;
  category?: MemoryCategory;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listMemories(
  db: Database,
  ownerId: string,
  filters: ListMemoryFilters = {},
): Promise<{ items: MemoryRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
  const conditions = [eq(memories.ownerId, ownerId)];
  if (filters.scope) conditions.push(eq(memories.scope, filters.scope));
  if (filters.taskId) conditions.push(eq(memories.taskId, filters.taskId));
  if (filters.category) conditions.push(eq(memories.category, filters.category));
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[%_]/g, '\\$&')}%`;
    conditions.push(
      sql`(to_tsvector('simple', ${memories.content}) @@ websearch_to_tsquery('simple', ${filters.q}) or ${memories.content} ilike ${pattern} or coalesce(${memories.semanticKey}, '') ilike ${pattern})`,
    );
  }
  const where = and(...conditions);
  const items = await db
    .select()
    .from(memories)
    .where(where)
    .orderBy(
      filters.q
        ? sql`ts_rank(to_tsvector('simple', ${memories.content}), websearch_to_tsquery('simple', ${filters.q})) desc, ${memories.updatedAt} desc`
        : desc(memories.updatedAt),
    )
    .limit(limit)
    .offset(offset);
  const totalRows = await db.select({ count: sql<number>`count(*)::int` }).from(memories).where(where);
  return { items, total: Number(totalRows[0]?.count ?? 0), limit, offset };
}

export async function findDuplicateMemoriesForOwner(
  db: Database,
  input: { ownerId: string; scope: MemoryScope; taskId?: string | null; content: string; semanticKey?: string | null; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const conditions = [eq(memories.ownerId, input.ownerId), eq(memories.scope, input.scope)];
  conditions.push(input.taskId ? eq(memories.taskId, input.taskId) : sql`${memories.taskId} is null`);
  const candidates = await db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.updatedAt))
    .limit(300);
  const mapped: MemoryCandidate[] = candidates
    .filter((row) => row.id !== input.excludeId)
    .map((row) => ({
      id: row.id,
      scope: row.scope as MemoryScope,
      taskId: row.taskId,
      category: row.category as MemoryCategory,
      content: row.content,
      semanticKey: row.semanticKey,
      updatedAt: row.updatedAt,
    }));
  return findDuplicateMemories({ content: input.content, semanticKey: input.semanticKey }, mapped);
}

/* ------------------------------------------------------------------ *
 * Automatic task learning
 * ------------------------------------------------------------------ */

export interface TaskLearningResult {
  mode: MemoryLearningMode;
  applied: number;
  suggested: number;
  skipped: Array<{ kind: 'memory' | 'recommendation'; reason: string }>;
  createdRecommendations: number;
  updatedRecommendations: number;
  unchangedRecommendations: number;
  meaningfulRecommendations: string[];
}

async function hasTombstone(
  tx: Transaction,
  input: { ownerId: string; scope: MemoryScope; taskId: string | null; semanticKey: string | null; contentHash: string },
): Promise<boolean> {
  const conditions = [
    eq(memoryTombstones.ownerId, input.ownerId),
    eq(memoryTombstones.scope, input.scope),
    input.taskId ? eq(memoryTombstones.taskId, input.taskId) : sql`${memoryTombstones.taskId} is null`,
  ];
  const keyOrHash = input.semanticKey
    ? sql`(${memoryTombstones.semanticKey} = ${input.semanticKey} or ${memoryTombstones.contentHash} = ${input.contentHash})`
    : eq(memoryTombstones.contentHash, input.contentHash);
  const rows = await tx.select({ id: memoryTombstones.id }).from(memoryTombstones).where(and(...conditions, keyOrHash)).limit(1);
  return Boolean(rows[0]);
}

async function countTaskMemories(tx: Transaction, ownerId: string, taskId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.taskId, taskId)));
  return Number(rows[0]?.count ?? 0);
}

async function findTaskMemoryByKeyOrContent(
  tx: Transaction,
  ownerId: string,
  taskId: string,
  semanticKey: string | null,
  content: string,
): Promise<MemoryRow | null> {
  const scopeCondition = semanticKey
    ? sql`(${memories.semanticKey} = ${semanticKey} or ${memories.content} = ${content})`
    : eq(memories.content, content);
  const rows = await tx
    .select()
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.taskId, taskId), scopeCondition))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function queueSuggestion(
  tx: Transaction,
  input: {
    ownerId: string;
    taskId: string;
    executionId: string;
    targetMemoryId: string | null;
    category: MemoryCategory;
    content: string;
    semanticKey: string | null;
    reason: string | null;
  },
): Promise<string> {
  const identity = input.semanticKey
    ? eq(memorySuggestions.semanticKey, input.semanticKey)
    : eq(memorySuggestions.content, input.content);
  const existing = await tx
    .select({ id: memorySuggestions.id })
    .from(memorySuggestions)
    .where(
      and(
        eq(memorySuggestions.ownerId, input.ownerId),
        eq(memorySuggestions.taskId, input.taskId),
        eq(memorySuggestions.status, 'pending'),
        identity,
      ),
    )
    .for('update')
    .limit(1);
  if (existing[0]) {
    await tx
      .update(memorySuggestions)
      .set({
        executionId: input.executionId,
        targetMemoryId: input.targetMemoryId,
        category: input.category,
        content: input.content,
        semanticKey: input.semanticKey,
        reason: input.reason,
        provenance: { source: 'agent', executionId: input.executionId },
      })
      .where(eq(memorySuggestions.id, existing[0].id));
    return existing[0].id;
  }
  const id = randomUUID();
  await tx.insert(memorySuggestions).values({
    id,
    ownerId: input.ownerId,
    taskId: input.taskId,
    executionId: input.executionId,
    targetMemoryId: input.targetMemoryId,
    operation: input.targetMemoryId ? 'upsert' : 'create',
    category: input.category,
    content: input.content,
    semanticKey: input.semanticKey,
    status: 'pending',
    reason: input.reason,
    provenance: { source: 'agent', executionId: input.executionId },
  });
  return id;
}

async function applyMemoryOp(
  tx: Transaction,
  input: {
    ownerId: string;
    taskId: string;
    executionId: string;
    mode: MemoryLearningMode;
    op: AgentMemoryOp;
    result: TaskLearningResult;
  },
): Promise<void> {
  const { op, result } = input;
  const skip = async (reason: string, memoryId: string | null = null): Promise<void> => {
    result.skipped.push({ kind: 'memory', reason });
    // Keep skipped automatic operations visible to the user without writing a memory.
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId,
      memoryId,
      executionId: input.executionId,
      action: 'skipped',
      scope: 'task',
      summary: reason,
    });
  };
  if (!TASK_MEMORY_CATEGORIES.includes(op.category)) {
    await skip(`invalid task category ${op.category}`);
    return;
  }
  let content: string;
  try {
    content = prepareContent(op.content);
  } catch (error) {
    await skip(error instanceof Error ? error.message : 'invalid memory');
    return;
  }
  const semanticKey = op.semanticKey?.trim() || null;
  if (await hasTombstone(tx, { ownerId: input.ownerId, scope: 'task', taskId: input.taskId, semanticKey, contentHash: hashContent(content) })) {
    await skip('blocked by deletion tombstone; deleted memory is not restored automatically');
    return;
  }

  const existing = await findTaskMemoryByKeyOrContent(tx, input.ownerId, input.taskId, semanticKey, content);
  if (existing?.userEdited) {
    if (input.mode === 'suggest') {
      const suggestionId = await queueSuggestion(tx, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        executionId: input.executionId,
        targetMemoryId: existing.id,
        category: op.category,
        content,
        semanticKey: semanticKey ?? existing.semanticKey,
        reason: 'user-edited memory; explicit approval is required before replacing it',
      });
      await recordChange(tx, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        memoryId: existing.id,
        executionId: input.executionId,
        suggestionId,
        action: 'suggested',
        scope: 'task',
        beforeContent: existing.content,
        afterContent: content,
        summary: 'automatic update of a user-edited memory awaits approval',
      });
      result.suggested += 1;
    } else {
      await skip('user-edited memory is protected from automatic overwrite', existing.id);
    }
    return;
  }

  if (input.mode === 'suggest') {
    const suggestionId = await queueSuggestion(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId,
      executionId: input.executionId,
      targetMemoryId: existing?.id ?? null,
      category: op.category,
      content,
      semanticKey: semanticKey ?? existing?.semanticKey ?? null,
      reason: null,
    });
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId,
      memoryId: existing?.id ?? null,
      executionId: input.executionId,
      suggestionId,
      action: 'suggested',
      scope: 'task',
      beforeContent: existing?.content ?? null,
      afterContent: content,
      summary: existing ? 'automatic update proposal' : 'automatic new-memory proposal',
    });
    result.suggested += 1;
    return;
  }

  if (!existing && (await countTaskMemories(tx, input.ownerId, input.taskId)) >= MAX_MEMORIES_PER_SCOPE) {
    await skip(`task memory limit reached (${MAX_MEMORIES_PER_SCOPE})`);
    return;
  }

  if (existing) {
    const revision = existing.revision + 1;
    await tx
      .update(memories)
      .set({
        content,
        category: op.category,
        semanticKey: semanticKey ?? existing.semanticKey,
        origin: 'agent',
        originRef: input.executionId,
        revision,
        updatedAt: new Date(),
      })
      .where(eq(memories.id, existing.id));
    await insertRevision(tx, {
      memoryId: existing.id,
      revision,
      content,
      category: op.category,
      semanticKey: semanticKey ?? existing.semanticKey,
      changedBy: 'agent',
      executionId: input.executionId,
    });
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId,
      memoryId: existing.id,
      executionId: input.executionId,
      action: 'updated',
      scope: 'task',
      beforeContent: existing.content,
      afterContent: content,
      summary: 'automatic task memory update',
    });
  } else {
    const id = randomUUID();
    await tx.insert(memories).values({
      id,
      ownerId: input.ownerId,
      taskId: input.taskId,
      scope: 'task',
      category: op.category,
      content,
      semanticKey,
      origin: 'agent',
      originRef: input.executionId,
      provenance: { executionId: input.executionId },
      userEdited: false,
    });
    await insertRevision(tx, {
      memoryId: id,
      revision: 1,
      content,
      category: op.category,
      semanticKey,
      changedBy: 'agent',
      executionId: input.executionId,
    });
    await recordChange(tx, {
      ownerId: input.ownerId,
      taskId: input.taskId,
      memoryId: id,
      executionId: input.executionId,
      action: 'created',
      scope: 'task',
      afterContent: content,
      summary: 'automatic task memory entry',
    });
  }
  result.applied += 1;
}

async function applyRecommendationOp(
  tx: Transaction,
  input: { ownerId: string; taskId: string; executionId: string; op: AgentRecommendationOp; result: TaskLearningResult },
): Promise<void> {
  const { op } = input;
  await lock(tx, `recommendation:${input.taskId}:${op.stableKey}`);
  const rows = await tx
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.taskId, input.taskId), eq(recommendations.semanticKey, op.stableKey)))
    .for('update')
    .limit(1);
  const existing = rows[0];
  const now = new Date();
  const metadata = (op.metadata ?? {}) as Record<string, unknown>;

  if (!existing) {
    await tx.insert(recommendations).values({
      id: randomUUID(),
      ownerId: input.ownerId,
      taskId: input.taskId,
      semanticKey: op.stableKey,
      title: op.title,
      description: op.description,
      sourceUrl: op.sourceUrl ?? null,
      status: op.status,
      metadata,
      firstObservedAt: now,
      lastObservedAt: now,
      lastChangedAt: now,
      statusChangedAt: now,
      firstExecutionId: input.executionId,
      lastExecutionId: input.executionId,
    });
    const created = await tx
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.taskId, input.taskId), eq(recommendations.semanticKey, op.stableKey)))
      .limit(1);
    if (created[0]) {
      await tx.insert(recommendationEvents).values({
        id: randomUUID(),
        recommendationId: created[0].id,
        executionId: input.executionId,
        action: 'created',
        toStatus: op.status,
        changes: { title: op.title, status: op.status },
      });
    }
    input.result.createdRecommendations += 1;
    input.result.meaningfulRecommendations.push(op.stableKey);
    return;
  }

  const userDecided = ['accepted', 'completed', 'rejected'].includes(existing.status);
  let status = existing.status as RecommendationStatus;
  if (!userDecided) {
    if (existing.status === 'unavailable' && op.status !== 'unavailable') status = op.status;
    else if (op.status === 'unavailable') status = 'unavailable';
    else if (existing.status === 'discovered' && op.status === 'recommended') status = 'recommended';
  }

  const titleChanged = existing.title !== op.title;
  const descriptionChanged = existing.description !== op.description;
  const sourceChanged = (existing.sourceUrl ?? null) !== (op.sourceUrl ?? null);
  const statusChanged = status !== existing.status;
  const meaningful = titleChanged || descriptionChanged || sourceChanged || statusChanged;
  const metadataChanged = JSON.stringify(existing.metadata) !== JSON.stringify(metadata);

  await tx
    .update(recommendations)
    .set({
      title: op.title,
      description: op.description,
      sourceUrl: op.sourceUrl ?? null,
      status,
      metadata,
      lastObservedAt: now,
      lastExecutionId: input.executionId,
      ...(meaningful ? { lastChangedAt: now } : {}),
      ...(statusChanged ? { statusChangedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(recommendations.id, existing.id));

  if (meaningful || metadataChanged) {
    await tx.insert(recommendationEvents).values({
      id: randomUUID(),
      recommendationId: existing.id,
      executionId: input.executionId,
      action: meaningful ? 'changed' : 'observed',
      fromStatus: existing.status,
      toStatus: status,
      changes: {
        ...(titleChanged ? { previousTitle: existing.title, title: op.title } : {}),
        ...(descriptionChanged ? { descriptionChanged: true } : {}),
        ...(sourceChanged ? { previousSourceUrl: existing.sourceUrl, sourceUrl: op.sourceUrl ?? null } : {}),
        ...(statusChanged ? { previousStatus: existing.status, status } : {}),
        ...(metadataChanged ? { metadataChanged: true } : {}),
      },
    });
    input.result.updatedRecommendations += 1;
    if (meaningful) input.result.meaningfulRecommendations.push(op.stableKey);
  } else {
    input.result.unchangedRecommendations += 1;
  }
}

/**
 * Applies only validated, structured operations from one successful execution.
 * There is no free-form database write and no path to global memory here.
 */
export async function applyTaskLearning(
  db: Database,
  input: {
    ownerId: string;
    taskId: string;
    executionId: string;
    mode: MemoryLearningMode;
    memoryOps: readonly unknown[];
    recommendationOps: readonly unknown[];
  },
): Promise<TaskLearningResult> {
  const result: TaskLearningResult = {
    mode: input.mode,
    applied: 0,
    suggested: 0,
    skipped: [],
    createdRecommendations: 0,
    updatedRecommendations: 0,
    unchangedRecommendations: 0,
    meaningfulRecommendations: [],
  };
  if (input.mode === 'off') return result;

  return db.transaction(async (tx) => {
    await assertTaskOwned(tx, input.ownerId, input.taskId);
    // Serialise learning per task so concurrent workers cannot duplicate content
    // or race the per-scope limit.
    await lock(tx, `task-learning:${input.taskId}`);
    for (const raw of input.memoryOps.slice(0, 30)) {
      const parsed = agentMemoryOpSchema.safeParse(raw);
      if (!parsed.success) {
        result.skipped.push({ kind: 'memory', reason: 'invalid structured memory operation' });
        continue;
      }
      await applyMemoryOp(tx, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        executionId: input.executionId,
        mode: input.mode,
        op: parsed.data,
        result,
      });
    }
    for (const raw of input.recommendationOps.slice(0, 100)) {
      const parsed = agentRecommendationOpSchema.safeParse(raw);
      if (!parsed.success) {
        result.skipped.push({ kind: 'recommendation', reason: 'invalid structured recommendation operation' });
        continue;
      }
      await applyRecommendationOp(tx, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        executionId: input.executionId,
        op: parsed.data,
        result,
      });
    }
    return result;
  });
}

/* ------------------------------------------------------------------ *
 * Review, recommendations and context retrieval
 * ------------------------------------------------------------------ */

export async function listMemoryChanges(
  db: Database,
  ownerId: string,
  filters: { taskId?: string; executionId?: string; limit?: number } = {},
): Promise<MemoryChangeRow[]> {
  const conditions = [eq(memoryChanges.ownerId, ownerId)];
  if (filters.taskId) conditions.push(eq(memoryChanges.taskId, filters.taskId));
  if (filters.executionId) conditions.push(eq(memoryChanges.executionId, filters.executionId));
  return db
    .select()
    .from(memoryChanges)
    .where(and(...conditions))
    .orderBy(desc(memoryChanges.createdAt))
    .limit(Math.min(filters.limit ?? 100, 200));
}

export async function listMemorySuggestions(
  db: Database,
  ownerId: string,
  filters: { taskId?: string; status?: string; limit?: number } = {},
): Promise<SuggestionRow[]> {
  const conditions = [eq(memorySuggestions.ownerId, ownerId)];
  if (filters.taskId) conditions.push(eq(memorySuggestions.taskId, filters.taskId));
  if (filters.status) conditions.push(eq(memorySuggestions.status, filters.status));
  return db
    .select()
    .from(memorySuggestions)
    .where(and(...conditions))
    .orderBy(desc(memorySuggestions.createdAt))
    .limit(Math.min(filters.limit ?? 100, 200));
}

async function applySuggestionWithin(tx: Transaction, ownerId: string, suggestion: SuggestionRow): Promise<MemoryRow> {
  await assertTaskOwned(tx, ownerId, suggestion.taskId);
  const content = prepareContent(suggestion.content);
  const semanticKey = suggestion.semanticKey;
  if (
    await hasTombstone(tx, {
      ownerId,
      scope: 'task',
      taskId: suggestion.taskId,
      semanticKey,
      contentHash: hashContent(content),
    })
  ) {
    await tx
      .update(memorySuggestions)
      .set({ status: 'rejected', reason: 'blocked by deletion tombstone', reviewedAt: new Date() })
      .where(eq(memorySuggestions.id, suggestion.id));
    throw AppError.conflict('this memory was deleted by the user and cannot be restored from a suggestion');
  }

  let target: MemoryRow | null = null;
  if (suggestion.targetMemoryId) {
    const rows = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, suggestion.targetMemoryId), eq(memories.ownerId, ownerId)))
      .for('update')
      .limit(1);
    target = rows[0] ?? null;
  }
  if (!target && semanticKey) {
    const rows = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.ownerId, ownerId), eq(memories.taskId, suggestion.taskId), eq(memories.semanticKey, semanticKey)))
      .for('update')
      .limit(1);
    target = rows[0] ?? null;
  }

  let saved: MemoryRow;
  if (target) {
    const revision = target.revision + 1;
    const [updated] = await tx
      .update(memories)
      .set({
        content,
        category: suggestion.category,
        semanticKey: semanticKey ?? target.semanticKey,
        revision,
        userEdited: true,
        origin: 'user',
        originRef: suggestion.executionId,
        updatedAt: new Date(),
      })
      .where(eq(memories.id, target.id))
      .returning();
    if (!updated) throw new Error('suggestion update returned no row');
    saved = updated;
    await insertRevision(tx, {
      memoryId: target.id,
      revision,
      content,
      category: suggestion.category,
      semanticKey: semanticKey ?? target.semanticKey,
      changedBy: 'user',
      executionId: suggestion.executionId,
    });
  } else {
    const id = randomUUID();
    const [created] = await tx
      .insert(memories)
      .values({
        id,
        ownerId,
        taskId: suggestion.taskId,
        scope: 'task',
        category: suggestion.category,
        content,
        semanticKey,
        origin: 'user',
        originRef: suggestion.executionId,
        provenance: { acceptedSuggestionId: suggestion.id },
        userEdited: true,
      })
      .returning();
    if (!created) throw new Error('suggestion insert returned no row');
    saved = created;
    await insertRevision(tx, {
      memoryId: id,
      revision: 1,
      content,
      category: suggestion.category,
      semanticKey,
      changedBy: 'user',
      executionId: suggestion.executionId,
    });
  }
  await tx
    .update(memorySuggestions)
    .set({ status: 'accepted', targetMemoryId: saved.id, reviewedAt: new Date() })
    .where(eq(memorySuggestions.id, suggestion.id));
  await tx
    .update(memorySuggestions)
    .set({ status: 'rejected', reason: 'a related suggestion was accepted', reviewedAt: new Date() })
    .where(
      and(
        eq(memorySuggestions.taskId, suggestion.taskId),
        eq(memorySuggestions.status, 'pending'),
        semanticKey ? eq(memorySuggestions.semanticKey, semanticKey) : eq(memorySuggestions.id, suggestion.id),
      ),
    );
  await recordChange(tx, {
    ownerId,
    taskId: suggestion.taskId,
    memoryId: saved.id,
    executionId: suggestion.executionId,
    suggestionId: suggestion.id,
    action: 'suggestion_accepted',
    scope: 'task',
    afterContent: content,
    summary: target ? 'accepted an automatic update proposal' : 'accepted an automatic new-memory proposal',
  });
  return saved;
}

export async function reviewMemorySuggestion(
  db: Database,
  ownerId: string,
  suggestionId: string,
  decision: 'accept' | 'reject',
): Promise<MemoryRow | null> {
  return db.transaction(async (tx) => {
    await lock(tx, `suggestion:${suggestionId}`);
    const rows = await tx
      .select()
      .from(memorySuggestions)
      .where(and(eq(memorySuggestions.id, suggestionId), eq(memorySuggestions.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const suggestion = rows[0];
    if (!suggestion) throw AppError.notFound('memory suggestion');
    if (suggestion.status !== 'pending') throw AppError.conflict('this suggestion has already been reviewed');
    if (decision === 'reject') {
      await tx
        .update(memorySuggestions)
        .set({ status: 'rejected', reviewedAt: new Date() })
        .where(eq(memorySuggestions.id, suggestion.id));
      await recordChange(tx, {
        ownerId,
        taskId: suggestion.taskId,
        memoryId: null,
        executionId: suggestion.executionId,
        suggestionId: suggestion.id,
        action: 'suggestion_rejected',
        scope: 'task',
        summary: 'automatic memory proposal rejected by user',
      });
      return null;
    }
    return applySuggestionWithin(tx, ownerId, suggestion);
  });
}

export async function listRecommendations(
  db: Database,
  ownerId: string,
  filters: { taskId?: string; status?: RecommendationStatus; limit?: number } = {},
): Promise<RecommendationRow[]> {
  const conditions = [eq(recommendations.ownerId, ownerId)];
  if (filters.taskId) conditions.push(eq(recommendations.taskId, filters.taskId));
  if (filters.status) conditions.push(eq(recommendations.status, filters.status));
  return db
    .select()
    .from(recommendations)
    .where(and(...conditions))
    .orderBy(desc(recommendations.lastObservedAt))
    .limit(Math.min(filters.limit ?? 200, 500));
}

export async function setRecommendationStatus(
  db: Database,
  ownerId: string,
  recommendationId: string,
  status: RecommendationStatus,
  executionId?: string | null,
): Promise<RecommendationRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, recommendationId), eq(recommendations.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (!existing) throw AppError.notFound('recommendation');
    const now = new Date();
    const [updated] = await tx
      .update(recommendations)
      .set({ status, statusChangedAt: now, lastChangedAt: now, updatedAt: now })
      .where(eq(recommendations.id, existing.id))
      .returning();
    if (!updated) throw new Error('recommendation update returned no row');
    await tx.insert(recommendationEvents).values({
      id: randomUUID(),
      recommendationId: existing.id,
      executionId: executionId ?? null,
      action: 'status_changed',
      fromStatus: existing.status,
      toStatus: status,
      changes: { previousStatus: existing.status, status },
    });
    return updated;
  });
}

export async function listRecommendationEvents(
  db: Database,
  ownerId: string,
  filters: { recommendationId?: string; executionId?: string; taskId?: string; limit?: number } = {},
) {
  const conditions = [eq(recommendations.ownerId, ownerId)];
  if (filters.recommendationId) conditions.push(eq(recommendationEvents.recommendationId, filters.recommendationId));
  if (filters.executionId) conditions.push(eq(recommendationEvents.executionId, filters.executionId));
  if (filters.taskId) conditions.push(eq(recommendations.taskId, filters.taskId));
  return db
    .select({
      id: recommendationEvents.id,
      recommendationId: recommendationEvents.recommendationId,
      executionId: recommendationEvents.executionId,
      action: recommendationEvents.action,
      fromStatus: recommendationEvents.fromStatus,
      toStatus: recommendationEvents.toStatus,
      changes: recommendationEvents.changes,
      createdAt: recommendationEvents.createdAt,
      title: recommendations.title,
      semanticKey: recommendations.semanticKey,
      taskId: recommendations.taskId,
    })
    .from(recommendationEvents)
    .innerJoin(recommendations, eq(recommendations.id, recommendationEvents.recommendationId))
    .where(and(...conditions))
    .orderBy(desc(recommendationEvents.createdAt))
    .limit(Math.min(filters.limit ?? 100, 200));
}

/** Context is read fresh for every execution; there is no process or query cache. */
export async function loadMemoryContextData(
  db: Database,
  ownerId: string,
  taskId: string,
  limits: { memories?: number; recommendations?: number } = {},
) {
  const global = await db
    .select()
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.scope, 'global')))
    .orderBy(desc(memories.updatedAt))
    .limit(limits.memories ?? 1_000);
  const task = await db
    .select()
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.taskId, taskId)))
    .orderBy(desc(memories.updatedAt))
    .limit(limits.memories ?? 1_000);
  const tracked = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.ownerId, ownerId), eq(recommendations.taskId, taskId)))
    .orderBy(desc(recommendations.lastObservedAt))
    .limit(limits.recommendations ?? 100);
  return { global, task, recommendations: tracked };
}

export async function exportMemories(db: Database, ownerId: string) {
  const memoryRows = await db.select().from(memories).where(eq(memories.ownerId, ownerId)).orderBy(desc(memories.updatedAt));
  const recommendationRows = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.ownerId, ownerId))
    .orderBy(desc(recommendations.lastObservedAt));
  const tombstones = await db
    .select({
      scope: memoryTombstones.scope,
      taskId: memoryTombstones.taskId,
      semanticKey: memoryTombstones.semanticKey,
      contentHash: memoryTombstones.contentHash,
      createdAt: memoryTombstones.createdAt,
    })
    .from(memoryTombstones)
    .where(eq(memoryTombstones.ownerId, ownerId))
    .orderBy(desc(memoryTombstones.createdAt));
  return {
    exportedAt: new Date().toISOString(),
    memories: memoryRows,
    recommendations: recommendationRows,
    /** Content-free deletion markers explain why some forgotten items are not re-learned. */
    deletionMarkers: tombstones,
  };
}

export async function countMemories(
  db: Database,
  ownerId: string,
  filters: { scope?: MemoryScope; taskId?: string } = {},
): Promise<number> {
  const conditions = [eq(memories.ownerId, ownerId)];
  if (filters.scope) conditions.push(eq(memories.scope, filters.scope));
  if (filters.taskId) conditions.push(eq(memories.taskId, filters.taskId));
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(memories).where(and(...conditions));
  return Number(rows[0]?.count ?? 0);
}
