import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TaskEndCondition, TaskShareSnapshot } from '@agent-tasks/shared';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

/**
 * Better Auth hands the adapter ISO strings for its own fields; `mode: 'string'` keeps
 * that boundary honest instead of forcing every caller to pre-convert dates.
 */
const authTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
};

/* ------------------------------------------------------------------ *
 * Better Auth tables (snake_case, drizzle adapter with provider "pg")
 * ------------------------------------------------------------------ */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('USER'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true, mode: 'date' }),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  ...authTimestamps,
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    ...authTimestamps,
  },
  (table) => [index('session_user_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true, mode: 'date' }),
    scope: text('scope'),
    password: text('password'),
    ...authTimestamps,
  },
  (table) => [index('account_user_idx').on(table.userId)],
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  ...authTimestamps,
});

export const twoFactor = pgTable('two_factor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Better Auth's TOTP state machine (schema check enforced by the library). */
  verified: boolean('verified').notNull().default(false),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
});

export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key'),
  count: integer('count'),
  /** Epoch milliseconds, as Better Auth defines it. */
  lastRequest: bigint('last_request', { mode: 'number' }),
});

/* ------------------------------------------------------------------ *
 * Application tables
 * ------------------------------------------------------------------ */

export const systemSettings = pgTable('system_settings', {
  id: integer('id').primaryKey().default(1),
  values: jsonb('values').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('Europe/Vienna'),
  locale: text('locale').notNull().default('en'),
  theme: text('theme').notNull().default('system'),
  ...timestamps,
});

export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    config: jsonb('config').notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex('providers_name_unique').on(table.name)],
);

/**
 * Credentials are stored as AES-256-GCM ciphertext. `owner_id = null` marks an
 * administrator-managed credential that may be shared by tasks; a non-null value
 * marks a personal credential that only its owner may use.
 */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default('default'),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex('provider_credentials_scope_unique').on(table.providerId, table.ownerId, table.label)],
);

export const providerModels = pgTable(
  'provider_models',
  {
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    label: text('label').notNull(),
    supportsTools: boolean('supports_tools').notNull().default(false),
    contextLength: integer('context_length'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    prompt: text('prompt').notNull(),
    systemInstructions: text('system_instructions'),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    model: text('model').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    schedule: jsonb('schedule').notNull(),
    endCondition: jsonb('end_condition').$type<TaskEndCondition>().notNull().default({ type: 'never' }),
    scheduledRunCount: integer('scheduled_run_count').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    timezone: text('timezone').notNull(),
    limits: jsonb('limits').notNull(),
    allowWebResearch: boolean('allow_web_research').notNull().default(true),
    notification: text('notification').notNull().default('none'),
    /**
     * Per-task automatic learning policy: `off`, `suggest` (review queue) or
     * `auto` (apply validated operations and show them in the change log).
     * `contextBytes` caps the memory block injected into a run.
     */
    memorySettings: jsonb('memory_settings').notNull().default({}),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    index('tasks_owner_idx').on(table.ownerId),
    index('tasks_due_idx').on(table.enabled, table.nextRunAt),
  ],
);

/**
 * Public share links carry a frozen, definition-only snapshot. The bearer token
 * is shown once at creation and only its SHA-256 hash is stored, so a database
 * leak cannot be replayed. Revocation is a soft delete so the owner keeps an
 * audit trail; revoking never touches tasks already adopted from the link.
 */
export const taskShares = pgTable(
  'task_shares',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Denormalised owner for owner-scoped listing; the foreign key cascades. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    snapshot: jsonb('snapshot').$type<TaskShareSnapshot>().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('task_shares_token_unique').on(table.tokenHash),
    index('task_shares_task_idx').on(table.taskId, table.createdAt),
    index('task_shares_owner_idx').on(table.ownerId, table.createdAt),
  ],
);

export const executions = pgTable(
  'executions',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Denormalised snapshot so history survives later task edits. */
    taskTitle: text('task_title').notNull(),
    status: text('status').notNull(),
    trigger: text('trigger').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    attempt: integer('attempt').notNull().default(1),
    providerId: uuid('provider_id'),
    providerName: text('provider_name'),
    model: text('model'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    report: jsonb('report'),
    usage: jsonb('usage'),
    /** Null until this completed result is explicitly marked read by its owner. */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    workerId: text('worker_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    index('executions_task_idx').on(table.taskId, table.createdAt),
    index('executions_owner_idx').on(table.ownerId, table.createdAt),
    index('executions_status_idx').on(table.status),
    index('executions_unread_owner_task_idx')
      .on(table.ownerId, table.taskId)
      .where(sql`${table.status} = 'completed' and ${table.readAt} is null`),
    // One execution per scheduled occurrence — the durable exactly-once-per-occurrence guard.
    uniqueIndex('executions_occurrence_unique').on(table.taskId, table.scheduledFor),
  ],
);

/** Internal runtime mapping; never returned as part of the public execution record. */
export const executionOpenCodeSessions = pgTable('execution_opencode_sessions', {
  executionId: uuid('execution_id').primaryKey().references(() => executions.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  messageId: text('message_id').notNull(),
  promptDispatched: boolean('prompt_dispatched').notNull().default(false),
});

export const executionSteps = pgTable(
  'execution_steps',
  {
    id: uuid('id').primaryKey(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => executions.id, { onDelete: 'cascade' }),
    step: integer('step').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull().default({}),
    ok: boolean('ok').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    resultPreview: text('result_preview'),
  },
  (table) => [index('execution_steps_execution_idx').on(table.executionId, table.step)],
);

/**
 * Durable per-execution budget counters.
 *
 * The worker's OpenCode bridge used to count tool calls, page visits and search
 * queries in memory, so a pg-boss retry or a crash recovery started the run with
 * a fresh allowance. These rows are keyed by execution (never by attempt), which
 * makes a reservation survive both. The maxima are pinned on the first
 * reservation and can only tighten afterwards, so a retry can never widen a
 * budget. `max_output_bytes` is nullable: null means the run accounts output
 * without a cumulative cap.
 *
 * Reservations are performed by `reserveExecutionBudget` in
 * `execution-budget.ts`; it validates the caller against the execution's owner,
 * worker and active lease before touching a counter.
 */
export const executionBudgetCounters = pgTable(
  'execution_budget_counters',
  {
    executionId: uuid('execution_id')
      .primaryKey()
      .references(() => executions.id, { onDelete: 'cascade' }),
    /** Denormalised owner for owner-scoped reads; always taken from the execution row. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    calls: integer('calls').notNull().default(0),
    pages: integer('pages').notNull().default(0),
    searches: integer('searches').notNull().default(0),
    outputBytes: bigint('output_bytes', { mode: 'number' }).notNull().default(0),
    maxCalls: integer('max_calls').notNull(),
    maxPages: integer('max_pages').notNull(),
    maxSearches: integer('max_searches').notNull(),
    maxOutputBytes: bigint('max_output_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('execution_budget_counters_owner_idx').on(table.ownerId),
    check(
      'execution_budget_counters_non_negative',
      sql`${table.calls} >= 0 and ${table.pages} >= 0 and ${table.searches} >= 0 and ${table.outputBytes} >= 0 and ${table.maxCalls} >= 0 and ${table.maxPages} >= 0 and ${table.maxSearches} >= 0 and (${table.maxOutputBytes} is null or ${table.maxOutputBytes} >= 0)`,
    ),
  ],
);

export const executionSources = pgTable(
  'execution_sources',
  {
    id: uuid('id').primaryKey(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => executions.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }).notNull(),
    confidence: text('confidence').notNull().default('unknown'),
    excerpt: text('excerpt'),
  },
  (table) => [uniqueIndex('execution_sources_unique').on(table.executionId, table.url)],
);

/* ------------------------------------------------------------------ *
 * Persistent AI memory
 *
 * Memories are user-owned and either global (task_id null) or task-scoped.
 * Deletion is physical, with a content-free tombstone that prevents automatic
 * learning from resurrecting what the user explicitly forgot.
 * ------------------------------------------------------------------ */

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    category: text('category').notNull(),
    content: text('content').notNull(),
    semanticKey: text('semantic_key'),
    origin: text('origin').notNull(),
    originRef: text('origin_ref'),
    provenance: jsonb('provenance').notNull().default({}),
    revision: integer('revision').notNull().default(1),
    /** True once a user created, updated or explicitly confirmed the record. */
    userEdited: boolean('user_edited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('memories_owner_scope_idx').on(table.ownerId, table.scope, table.updatedAt),
    index('memories_task_idx').on(table.taskId, table.updatedAt),
    index('memories_search_idx').using('gin', sql`to_tsvector('simple', ${table.content})`),
    uniqueIndex('memories_global_semantic_unique')
      .on(table.ownerId, table.semanticKey)
      .where(sql`${table.scope} = 'global' and ${table.semanticKey} is not null`),
    uniqueIndex('memories_task_semantic_unique')
      .on(table.taskId, table.semanticKey)
      .where(sql`${table.scope} = 'task' and ${table.semanticKey} is not null`),
    check(
      'memories_scope_shape',
      sql`(${table.scope} = 'global' and ${table.taskId} is null) or (${table.scope} = 'task' and ${table.taskId} is not null)`,
    ),
  ],
);

export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    id: uuid('id').primaryKey(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    content: text('content').notNull(),
    category: text('category').notNull(),
    semanticKey: text('semantic_key'),
    metadata: jsonb('metadata').notNull().default({}),
    changedBy: text('changed_by').notNull(),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('memory_revisions_unique').on(table.memoryId, table.revision)],
);

/**
 * Content-free deletion marker. It stores only a hash of the forgotten text and
 * the semantic key, so it can block an automatic re-creation without retaining
 * the deleted content or exposing it to search or prompts.
 */
export const memoryTombstones = pgTable(
  'memory_tombstones',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    semanticKey: text('semantic_key'),
    contentHash: text('content_hash').notNull(),
    changedBy: text('changed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('memory_tombstones_owner_idx').on(table.ownerId, table.scope, table.createdAt),
    index('memory_tombstones_task_idx').on(table.taskId, table.createdAt),
  ],
);

export const memorySuggestions = pgTable(
  'memory_suggestions',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    targetMemoryId: uuid('target_memory_id').references(() => memories.id, { onDelete: 'set null' }),
    operation: text('operation').notNull().default('upsert'),
    category: text('category').notNull(),
    content: text('content').notNull(),
    semanticKey: text('semantic_key'),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    provenance: jsonb('provenance').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('memory_suggestions_task_idx').on(table.taskId, table.status, table.createdAt),
    index('memory_suggestions_owner_idx').on(table.ownerId, table.status, table.createdAt),
  ],
);

/**
 * User-visible change journal. Deletions intentionally never store the removed
 * text: `before_content`/`after_content` are nulled and `memory_id` becomes
 * null when the memory is physically deleted.
 */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').references(() => memories.id, { onDelete: 'set null' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    suggestionId: uuid('suggestion_id').references(() => memorySuggestions.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    scope: text('scope').notNull(),
    beforeContent: text('before_content'),
    afterContent: text('after_content'),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('memory_changes_owner_idx').on(table.ownerId, table.createdAt),
    index('memory_changes_task_idx').on(table.taskId, table.createdAt),
    index('memory_changes_execution_idx').on(table.executionId, table.createdAt),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    semanticKey: text('semantic_key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    sourceUrl: text('source_url'),
    status: text('status').notNull().default('discovered'),
    metadata: jsonb('metadata').notNull().default({}),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    firstExecutionId: uuid('first_execution_id').references(() => executions.id, { onDelete: 'set null' }),
    lastExecutionId: uuid('last_execution_id').references(() => executions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('recommendations_task_key_unique').on(table.taskId, table.semanticKey),
    index('recommendations_task_status_idx').on(table.taskId, table.status, table.lastObservedAt),
  ],
);

export const recommendationEvents = pgTable(
  'recommendation_events',
  {
    id: uuid('id').primaryKey(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    changes: jsonb('changes').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('recommendation_events_recommendation_idx').on(table.recommendationId, table.createdAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('audit_logs_actor_idx').on(table.actorId, table.createdAt)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role').notNull().default('USER'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('invitations_token_unique').on(table.tokenHash)],
);

export const schema = {
  user,
  session,
  account,
  verification,
  twoFactor,
  rateLimit,
  systemSettings,
  userPreferences,
  providers,
  providerCredentials,
  providerModels,
  tasks,
  taskShares,
  executions,
  executionOpenCodeSessions,
  executionSteps,
  executionSources,
  executionBudgetCounters,
  memories,
  memoryRevisions,
  memoryTombstones,
  memorySuggestions,
  memoryChanges,
  recommendations,
  recommendationEvents,
  auditLogs,
  invitations,
};

export type Schema = typeof schema;
