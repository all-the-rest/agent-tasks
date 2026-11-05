import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '@agent-tasks/database';
import {
  applyTaskLearning,
  executions,
  executionSources,
  executionSteps,
  loadMemoryContextData,
  providerCredentials,
  providerModels,
  providers,
  tasks,
  user,
  userPreferences,
  reserveExecutionBudget,
} from '@agent-tasks/database';
import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import type { RunAgentOptions, AgentRunResult, AgentStepRecord } from '@agent-tasks/agent-runtime';
import { BrowserRunnerClient, NoopSearchProvider, SearxngSearchProvider } from '@agent-tasks/browser-tools';
import type { SearchProvider } from '@agent-tasks/browser-tools';
import { ProviderError, SecretBox, contextFor, createProvider, redact, resolveCredential } from '@agent-tasks/ai-providers';
import {
  buildMemoryContext,
  catalogModelSupportsTools,
  mergeProviderCatalog,
  parseMemorySettings,
  renderEmailDocument,
  reportChangeStatus,
  checkReportLinks,
  buildConversationContext,
  CONVERSATION_CONTEXT_TURNS,
  scheduleSchema,
  systemSettingsSchema,
  taskRequiresTools,
  isExecutableProviderKind,
  resolveAgentLimits,
} from '@agent-tasks/shared';
import type { MemoryCategory, MemoryContextRecord, MemoryScope, RecommendationContextRecord } from '@agent-tasks/shared';
import { claimExecution, heartbeat, isCancelRequested } from './scheduling.js';
import { settleWithin } from './lifecycle.js';
import type { SettleResult } from './lifecycle.js';
import { collectKnownSecrets } from './credentials.js';
import { createMailer } from './mailer.js';
import type { Mailer } from './mailer.js';
import { QUEUE_EXECUTION } from './queues.js';
import type { WorkerEnv } from './env.js';
import type { OpenCodeExecutionLease } from './opencode-session-store.js';

export interface ExecutorDeps {
  db: Database;
  env: WorkerEnv;
  boss: PgBoss;
  workerId: string;
  /** Injectable for tests; defaults to SMTP/log based on the environment. */
  mailer?: Mailer;
  /** The only supported task execution path: a provisioned isolated OpenCode runtime. */
  openCodeRunner: (options: RunAgentOptions, lease: OpenCodeExecutionLease) => Promise<AgentRunResult>;
}

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;
/** How long a shutdown waits for aborted executions to settle before pg-boss takes over. */
export const SHUTDOWN_GRACE_MS = 25_000;

/**
 * Timeline step numbers are partitioned per execution attempt. A deliberate
 * retry (`attempt` increments) clears only rows below its segment, while crash
 * recovery of the same attempt keeps them: that attempt may have already
 * executed tools whose result is still authoritative in the OpenCode session.
 * The width is far above the hard per-run tool-call cap (120), so segments can
 * never overlap.
 */
const STEP_SEGMENT = 1_000_000;
/** The shared `execution_steps` columns are documented as short text. */
const MAX_STEP_TEXT = 1_000;
/** Arguments are model-provided; cap each string and the whole JSON payload. */
const MAX_ARGUMENT_TEXT = 1_000;
const MAX_ARGUMENT_BYTES = 8_000;
const MAX_ARGUMENT_DEPTH = 5;
const MAX_ARGUMENT_ENTRIES = 50;

export function stepSegmentForAttempt(attempt: number): number {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return (normalized - 1) * STEP_SEGMENT;
}

/**
 * Redact values whose header names identify them as credentials. Ordinary metadata
 * headers (for example `X-Title`) must remain readable in user-visible reports.
 */
export function providerHeaderSecrets(config: unknown): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const headers = (config as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers as Record<string, unknown>)
    .filter(([name, value]) => /(?:auth|api[-_]?key|token|secret|credential|password|private[-_]?key|cookie)/i.test(name)
      && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value as string);
}

function redactedStepText(value: string, secrets: string[]): string {
  return redact(value, secrets).slice(0, MAX_STEP_TEXT);
}

function sanitizeArgumentValue(value: unknown, secrets: string[], depth: number): unknown {
  if (typeof value === 'string') return redact(value, secrets).slice(0, MAX_ARGUMENT_TEXT);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= MAX_ARGUMENT_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARGUMENT_ENTRIES)
      .map((item) => sanitizeArgumentValue(item, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ARGUMENT_ENTRIES)) {
      // `JSON.parse` can create these as own keys; assigning them would mutate
      // the persisted object's prototype instead of storing a value.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const safeKey = redact(key, secrets).slice(0, 120);
      result[safeKey] = /(?:secret|token|password|credential|authorization|api[_-]?key|private[_-]?key)/i.test(key)
        ? '[redacted]'
        : sanitizeArgumentValue(item, secrets, depth + 1);
    }
    return result;
  }
  return '[unsupported]';
}

/**
 * Tool arguments that are the durable memory itself. Persisting them in the
 * execution timeline would make a deleted or user-corrected memory readable from
 * old step history forever, so those fields are never copied into a step. The
 * validated operation still reaches the memory journal through the normal path.
 */
const PRIVATE_TOOLS = new Set(['record_task_memory', 'track_recommendation']);

/**
 * Turn arbitrary model-supplied arguments into a bounded JSON value. The values
 * are never trusted: every string is redacted and capped, nesting and entry
 * counts are bounded, and an oversized payload is replaced by a marker rather
 * than stored (or logged) in full.
 */
export function sanitizeStepArguments(tool: string, value: unknown, secrets: string[]): Record<string, unknown> {
  const sanitized = sanitizeArgumentValue(value, secrets, 0);
  const record = sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
  // The entire operation can contain user-editable or later-deleted content,
  // identifiers, or metadata. Do not retain a partial copy in execution history.
  const result = PRIVATE_TOOLS.has(tool) ? { redacted: true } : record;
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return { truncated: true };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  return bytes > MAX_ARGUMENT_BYTES ? { truncated: true, bytes } : result;
}

/** Why the executor aborted a run; mirrors the runtime's timeout/cancellation split. */
export type ExecutionAbortReason = 'timeout' | 'cancelled';

/**
 * Read the executor's abort cause from the controller it passed to the runtime.
 *
 * The deadline aborts with `'timeout'`; cancellation polling and shutdown abort
 * with `'cancelled'`. Any other reason (including a bare `abort()`) is treated as
 * cancellation, so an unknown abort can never be mistaken for a retryable failure.
 */
export function getExecutionAbortReason(signal: AbortSignal): ExecutionAbortReason | null {
  if (!signal.aborted) return null;
  return signal.reason === 'timeout' ? 'timeout' : 'cancelled';
}

/**
 * A failure observed after the executor aborted is not a provider failure: the
 * provisioner, browser session setup or runner may fail with a plain error or a
 * retryable `ProviderError('timeout')` merely because the abort interrupted it.
 * Classify it by the executor's own cause instead, so a deadline becomes
 * `timed_out` and a user cancellation stays `cancelled`, neither retried.
 */
export function classifyExecutionFailure(error: unknown, reason: ExecutionAbortReason | null): unknown {
  if (reason === null) return error;
  return new AgentCancelledError(reason);
}

export class Executor {
  private readonly secrets: SecretBox;
  private readonly browser: BrowserRunnerClient;
  private readonly mailer: Mailer;
  private running = new Map<string, AbortController>();
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: ExecutorDeps) {
    if (!deps.openCodeRunner) throw new Error('Isolated OpenCode execution provisioner is required');
    this.secrets = new SecretBox(deps.env.SECRETS_ENCRYPTION_KEY, deps.env.SECRETS_ENCRYPTION_KEY_PREVIOUS);
    this.browser = new BrowserRunnerClient({ baseUrl: deps.env.RUNNER_URL, token: deps.env.RUNNER_TOKEN, timeoutMs: 60_000 });
    this.mailer =
      deps.mailer ??
      createMailer({ smtpUrl: deps.env.SMTP_URL, from: deps.env.SMTP_FROM, nodeEnv: deps.env.NODE_ENV });
  }

  get activeExecutions(): number {
    return this.running.size;
  }

  /**
   * Abort every running execution and wait (bounded by `graceMs`) for it to settle, so
   * the caller can log whether the shutdown actually drained or the grace expired.
   */
  async abortAll(graceMs: number = SHUTDOWN_GRACE_MS): Promise<SettleResult> {
    for (const controller of this.running.values()) controller.abort('cancelled');
    return settleWithin(this.inFlight, graceMs);
  }

  async handle(executionId: string): Promise<void> {
    const execution = this.execute(executionId);
    this.inFlight.add(execution);
    try {
      await execution;
    } finally {
      this.inFlight.delete(execution);
    }
  }

  private async execute(executionId: string): Promise<void> {
    const { db } = this.deps;
    const settings = await this.loadSettings();
    const claim = await claimExecution(db, executionId, this.deps.workerId, LEASE_SECONDS, settings, MAX_ATTEMPTS);
    if (claim.status === 'not_claimed') {
      // Another worker already owns it, or the execution is no longer queued.
      return;
    }
    if (claim.status === 'deferred') {
      await this.deps.boss.send(QUEUE_EXECUTION, { executionId }, {
        startAfter: 30,
        singletonKey: `${executionId}:task-busy:${Math.floor(Date.now() / 30_000)}`,
        retryLimit: 0,
      });
      return;
    }
    if (claim.status === 'refused') {
      if (claim.retryAttempt !== null) {
        await this.deps.boss.send(QUEUE_EXECUTION, { executionId }, {
          startAfter: 30,
          singletonKey: `${executionId}:${claim.retryAttempt}`,
          retryLimit: 0,
        });
      }
      return;
    }

    const rows = await db
      .select({ execution: executions, task: tasks })
      .from(executions)
      .innerJoin(tasks, eq(tasks.id, executions.taskId))
      .where(eq(executions.id, executionId))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    const { execution, task } = row;

    if (await isCancelRequested(db, executionId)) {
      await db.update(executions).set({ status: 'cancelled', finishedAt: new Date(), error: 'cancel requested before start' }).where(eq(executions.id, executionId));
      return;
    }

    const abort = new AbortController();
    this.running.set(executionId, abort);
    const startedAt = new Date();
    const poll = setInterval(() => {
      void isCancelRequested(db, executionId).then((cancelled) => {
        if (cancelled) abort.abort('cancelled');
      });
      void heartbeat(db, executionId, LEASE_SECONDS);
    }, 2_000);

    const limits = resolveAgentLimits(settings.agentLimits);
    const deadline = setTimeout(() => {
      abort.abort('timeout');
    }, limits.maxDurationSec * 1_000);

    let browserSessionId: string | null = null;
    let runCompleted = false;
    const knownSecrets: string[] = [];
    try {
      if (task.ownerId !== execution.ownerId) throw new Error('execution owner does not match task owner');
      const providerRows = await db.select().from(providers).where(eq(providers.id, task.providerId)).limit(1);
      const provider = providerRows[0];
      if (!provider) throw new Error('provider record no longer exists');
      if (!provider.enabled) throw new Error('provider is disabled');

      // The provisioned OpenCode runtime currently accepts only OpenAI-compatible
      // provider records. Do not alias or silently translate Ollama, Codex, or the
      // legacy `openai` kind into a different execution contract.
      if (!isExecutableProviderKind(provider.kind)) {
        throw new ProviderError('unsupported', `provider kind ${provider.kind} is not supported by isolated OpenCode execution`);
      }

      // The task editor talks to the persisted discovery catalog, not to the
      // provider's declared fallback list. Load it so an id that the admin refreshed
      // stays runnable, and merge the admin's explicit capability overrides on top.
      const discovered = await db
        .select({
          id: providerModels.modelId,
          label: providerModels.label,
          supportsTools: providerModels.supportsTools,
          contextLength: providerModels.contextLength,
        })
        .from(providerModels)
        .where(eq(providerModels.providerId, provider.id));
      const providerConfig = {
        ...(provider.config as Record<string, unknown>),
        models: mergeProviderCatalog((provider.config as { models?: unknown }).models, discovered.map((model) => ({
          id: model.id,
          label: model.label,
          supportsTools: model.supportsTools,
          ...(model.contextLength !== null ? { contextLength: model.contextLength } : {}),
        }))),
      };

      const memorySettings = parseMemorySettings(task.memorySettings);
      // E-mail, research and memory are only real when the runtime may offer tools.
      // Refuse before provisioning instead of letting OpenCode run without them.
      if (taskRequiresTools({
        allowWebResearch: task.allowWebResearch,
        memoryMode: memorySettings.mode,
      }) && !catalogModelSupportsTools(providerConfig.models, task.model)) {
        throw new ProviderError(
          'unsupported',
          `model ${task.model} is not marked tool-capable on provider ${provider.name}; enable tools for it in the admin provider catalog or disable research and memory`,
        );
      }

      const credentials = await db.select().from(providerCredentials).where(eq(providerCredentials.providerId, provider.id));
      const decrypt = (value: string): string => this.secrets.decrypt(value);
      const credential = resolveCredential(credentials, task.ownerId, decrypt);
      // Any credential on this provider may end up in an error message (e.g. a shared key
      // echoed while a personal key is resolved), so redact all of them, not just the one
      // used for this run. Credential-like config headers may also be echoed by a gateway.
      knownSecrets.push(...collectKnownSecrets(credential.apiKey, credentials, decrypt));
      knownSecrets.push(...providerHeaderSecrets(providerConfig));

      const adapter = createProvider(provider.kind);
      const providerContext = contextFor({ ...provider, config: providerConfig }, credential.apiKey);

      if (task.allowWebResearch) {
        const session = await this.browser.createSession();
        browserSessionId = session.sessionId;
      }

      const search = this.searchProvider(settings);
      // The preflight above already refused a task that needs tools on a model that
      // the catalog does not explicitly mark as tool-capable, so memory tools are
      // never silently dropped here.
      const memoryToolsEnabled = memorySettings.mode !== 'off';
      let memoryContext: string | null = null;
      if (memorySettings.mode !== 'off') {
        // Read fresh on every execution: a deleted or edited memory can never be
        // served from a stale cache, a search index or a previous run's report.
        const contextData = await loadMemoryContextData(db, task.ownerId, task.id);
        const globalMemories: MemoryContextRecord[] = contextData.global.map((row) => ({
          id: row.id,
          scope: row.scope as MemoryScope,
          category: row.category as MemoryCategory,
          content: row.content,
          semanticKey: row.semanticKey,
          updatedAt: row.updatedAt,
        }));
        const taskMemories: MemoryContextRecord[] = contextData.task.map((row) => ({
          id: row.id,
          scope: row.scope as MemoryScope,
          category: row.category as MemoryCategory,
          content: row.content,
          semanticKey: row.semanticKey,
          updatedAt: row.updatedAt,
        }));
        const previousRecommendations: RecommendationContextRecord[] = contextData.recommendations.map((row) => ({
          id: row.id,
          semanticKey: row.semanticKey,
          title: row.title,
          status: row.status as RecommendationContextRecord['status'],
          sourceUrl: row.sourceUrl,
          lastObservedAt: row.lastObservedAt,
          lastChangedAt: row.lastChangedAt,
        }));
        const built = buildMemoryContext({
          globalMemories,
          taskMemories,
          recommendations: previousRecommendations,
          budgetBytes: memorySettings.contextBytes,
        });
        memoryContext = built.text;
      }

      let conversationContext: string | null = null;
      if (task.conversationMode === 'conversation') {
        const priorTurns = await db
          .select({ id: executions.id, status: executions.status, inputSnapshot: executions.inputSnapshot, report: executions.report })
          .from(executions)
          .where(
            and(
              eq(executions.taskId, task.id),
              eq(executions.ownerId, task.ownerId),
              eq(executions.status, 'completed'),
              ne(executions.id, executionId),
            ),
          )
          .orderBy(desc(executions.finishedAt), desc(executions.createdAt))
          .limit(CONVERSATION_CONTEXT_TURNS);
        conversationContext = buildConversationContext(
          priorTurns.map((turn) => ({
            id: turn.id,
            status: turn.status,
            inputSnapshot: turn.inputSnapshot,
            assistantOutput:
              typeof turn.report === 'object' && turn.report !== null && 'markdown' in turn.report && typeof turn.report.markdown === 'string'
                ? turn.report.markdown
                : null,
          })),
          executionId,
        );
      }

      // The timeline is per attempt but survives crash recovery of that attempt.
      // Old attempts live in lower step segments and are cleared here; rows of the
      // current attempt are kept and new calls are appended after their maximum.
      const segment = stepSegmentForAttempt(execution.attempt);
      const existingSteps = await db
        .select({ id: executionSteps.id, step: executionSteps.step, tool: executionSteps.tool })
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId));
      const staleIds = existingSteps.filter((row) => row.step < segment).map((row) => row.id);
      if (staleIds.length > 0) {
        await db.delete(executionSteps).where(inArray(executionSteps.id, staleIds));
      }
      const liveSteps = existingSteps.filter((row) => row.step >= segment);
      const syntheticIds = new Set(liveSteps.filter((row) => row.tool === 'opencode').map((row) => row.id));
      const assignedSteps = new Set(liveSteps.map((row) => row.step));
      const timelineBase = liveSteps.reduce((max, row) => Math.max(max, row.step), segment);
      let timelineWrite: Promise<void> = Promise.resolve();

      const persistStep = async (step: AgentStepRecord): Promise<void> => {
        // The runner's numbers are relative to its own run; the persisted number is
        // placed after the current attempt's existing rows. A repeated number can
        // never overwrite another row of the same attempt.
        let target = timelineBase + Math.max(1, Math.floor(step.step));
        while (assignedSteps.has(target)) target += 1;
        assignedSteps.add(target);

        const startedAtDate = new Date(step.startedAt);
        const finishedAtDate = new Date(step.finishedAt);
        const startedAt = Number.isNaN(startedAtDate.getTime()) ? new Date() : startedAtDate;
        const finishedAt = Number.isNaN(finishedAtDate.getTime()) ? new Date() : finishedAtDate;
        if (step.tool === 'opencode' && syntheticIds.size > 0) {
          // The terminal summary is a singleton per execution: a recovered replay
          // replaces the old row instead of adding a second synthetic step, and it
          // must never delete a real tool row that happens to share its number.
          await db.delete(executionSteps).where(inArray(executionSteps.id, [...syntheticIds]));
          syntheticIds.clear();
        }
        const id = randomUUID();
        if (step.tool === 'opencode') syntheticIds.add(id);
        await db.insert(executionSteps).values({
          id,
          executionId,
          step: target,
          tool: redactedStepText(step.tool, knownSecrets),
          args: sanitizeStepArguments(step.tool, step.arguments, knownSecrets),
          ok: step.ok === true,
          startedAt,
          finishedAt,
          durationMs: Number.isFinite(step.durationMs)
            ? Math.max(0, Math.floor(step.durationMs))
            : Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          error: step.error ? redactedStepText(step.error, knownSecrets) : null,
          resultPreview: PRIVATE_TOOLS.has(step.tool)
            ? (step.ok ? 'operation recorded' : 'operation rejected')
            : step.resultPreview ? redactedStepText(step.resultPreview, knownSecrets) : null,
        });
      };

      const runOptions = {
        provider: adapter,
        providerContext,
        model: task.model,
        title: task.title,
        prompt: execution.inputSnapshot || task.prompt,
        systemInstructions: task.systemInstructions,
        conversationContext,
        timezone: task.timezone,
        allowWebResearch: task.allowWebResearch,
        // Search/filter inputs may be filled during research; the model-facing tool
        // has no submit argument and the browser runner rejects submissions outright.
        allowForms: task.allowWebResearch,
        emailNotification: task.notification !== 'none',
        memoryEnabled: memoryToolsEnabled,
        memoryContext,
        limits,
        executionBudget: {
          reserveBudget: async (counters: Partial<Record<'calls' | 'pages' | 'searches' | 'outputBytes', number>>) => {
            return reserveExecutionBudget(db, {
              executionId,
              ownerId: execution.ownerId,
              workerId: this.deps.workerId,
              limits: {
                maxToolCalls: limits.maxToolCalls,
                maxPageVisits: limits.maxPageVisits,
                maxSearchQueries: limits.maxSearchQueries,
                // This cumulative cap accounts the bytes sent back to OpenCode;
                // each individual reply is also truncated to this same hard cap.
                maxOutputBytes: limits.maxOutputBytes,
              },
              counters,
            });
          },
        },
        browser: this.browser,
        sessionId: browserSessionId ?? randomUUID(),
        search,
        signal: abort.signal,
        onStep(step) {
          // Parallel tool calls may complete in any order; serialise both the
          // numbering and the writes so the offset stays a single source of truth.
          timelineWrite = timelineWrite.then(
            () => persistStep(step),
            () => persistStep(step),
          );
          return timelineWrite;
        },
      } as RunAgentOptions & {
        executionBudget: {
          reserveBudget(counters: Partial<Record<'calls' | 'pages' | 'searches' | 'outputBytes', number>>): ReturnType<typeof reserveExecutionBudget>;
        };
      };
      const result = await this.deps.openCodeRunner(runOptions, { executionId, ownerId: execution.ownerId, workerId: this.deps.workerId });
      runCompleted = true;

      const finishedAt = new Date();
      // Quiet runs: compare with the previous completed run so the notification
      // decision and the stored report can say whether anything actually changed.
      const previousRows = await db
        .select({ id: executions.id, report: executions.report })
        .from(executions)
        .where(and(eq(executions.taskId, task.id), eq(executions.status, 'completed'), ne(executions.id, executionId)))
        .orderBy(desc(executions.finishedAt))
        .limit(1);
      const previous = previousRows[0];
      // Only links a tool actually visited stay clickable; anything else is reduced
      // to plain text and surfaced as an uncertainty note instead of becoming a
      // plausible-looking hallucinated citation.
      const links = checkReportLinks(result.markdown, result.sources);
      const uncertainty = links.removed.length > 0
        ? [...result.uncertainty, `${links.removed.length} link(s) in the report were not backed by a visited source and were reduced to plain text.`]
        : result.uncertainty;
      const change = reportChangeStatus(
        (previous?.report as { markdown?: string } | null | undefined)?.markdown,
        links.markdown,
      );
      await db
        .update(executions)
        .set({
          status: 'completed',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          report: {
            summary: result.summary,
            markdown: links.markdown,
            sources: result.sources,
            uncertainty,
            change: { status: change, ...(previous ? { previousExecutionId: previous.id } : {}) },
            ...(result.emailBlocks.length > 0 ? { email: { blocks: result.emailBlocks } } : {}),
          },
          usage: result.usage,
          error: result.stopReason === 'step_limit' ? 'completed without a final model answer (step limit)' : null,
          providerName: provider.name,
          model: task.model,
        })
        .where(eq(executions.id, executionId));

      if (result.sources.length > 0) {
        await db
          .insert(executionSources)
          .values(
            result.sources.map((source) => ({
              id: randomUUID(),
              executionId,
              url: source.url.slice(0, 2_000),
              title: source.title?.slice(0, 300) ?? null,
              retrievedAt: new Date(source.retrievedAt),
              confidence: source.confidence,
              excerpt: source.excerpt ?? null,
            })),
          )
          .onConflictDoNothing();
      }
      await db.update(tasks).set({ lastRunAt: finishedAt }).where(eq(tasks.id, task.id));

      // Durable memory is written only after the execution was marked completed.
      // Operations are schema-validated in the worker and applied in one transaction;
      // a learning failure must never turn a completed execution into a failure.
      if (result.stopReason === 'completed' && memoryToolsEnabled) {
        try {
          const learning = await applyTaskLearning(db, {
            ownerId: task.ownerId,
            taskId: task.id,
            executionId,
            mode: memorySettings.mode,
            memoryOps: result.memoryOps,
            recommendationOps: result.recommendationOps,
          });
          if (
            learning.applied > 0 ||
            learning.suggested > 0 ||
            learning.createdRecommendations > 0 ||
            learning.updatedRecommendations > 0 ||
            learning.skipped.length > 0
          ) {
            console.info(
              JSON.stringify({
                level: 'info',
                event: 'task_memory_learning',
                executionId,
                mode: learning.mode,
                applied: learning.applied,
                suggested: learning.suggested,
                skipped: learning.skipped.length,
                recommendationsCreated: learning.createdRecommendations,
                recommendationsChanged: learning.updatedRecommendations,
                recommendationsUnchanged: learning.unchangedRecommendations,
              }),
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'task_memory_learning_failed',
              executionId,
              message: redact(error instanceof Error ? error.message : String(error), knownSecrets),
            }),
          );
        }
      }

      const notifyByEmail = task.notification === 'email'
        || (task.notification === 'email_on_change' && change !== 'unchanged');
      if (notifyByEmail) {
        // A notification failure must never turn a completed execution into a failure.
        await this.sendCompletionEmail({ task, executionId, result, finishedAt }).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'notification_failed',
              executionId,
              message: redact(error instanceof Error ? error.message : String(error), knownSecrets),
            }),
          );
        });
      }
    } catch (error) {
      // The runtime, provisioner or browser session may report an abort as a plain
      // error or as a transient provider failure. Before the run has completed, the
      // executor's own abort cause is authoritative: a deadline is `timed_out`,
      // a user/shutdown cancellation is `cancelled`, and neither is ever retried.
      // A genuine provider timeout with no abort keeps its retryable classification.
      const failure = classifyExecutionFailure(error, runCompleted ? null : getExecutionAbortReason(abort.signal));
      await this.failExecution(executionId, execution, failure, startedAt, knownSecrets);
    } finally {
      clearInterval(poll);
      clearTimeout(deadline);
      this.running.delete(executionId);
      if (browserSessionId) await this.browser.closeSession(browserSessionId);
    }
  }

  private async sendCompletionEmail(input: {
    task: typeof tasks.$inferSelect;
    executionId: string;
    result: AgentRunResult;
    finishedAt: Date;
  }): Promise<void> {
    const rows = await this.deps.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, input.task.ownerId))
      .limit(1);
    const recipient = rows[0]?.email;
    if (!recipient) return;

    const base = this.deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const content = renderEmailDocument({
      heading: `Task completed: ${input.task.title}`,
      intro: input.result.summary,
      blocks: input.result.emailBlocks,
      action: { label: 'Open execution', url: `${base}/executions/${input.executionId}` },
      footer: 'You receive this mail because this task is configured to notify you by e-mail.',
    });
    await this.mailer.send({ to: recipient, subject: `Task completed: ${input.task.title}`, ...content });
  }

  private async failExecution(
    executionId: string,
    execution: typeof executions.$inferSelect,
    error: unknown,
    startedAt: Date,
    knownSecrets: string[],
  ): Promise<void> {
    const { db } = this.deps;
    const finishedAt = new Date();
    if (error instanceof AgentCancelledError) {
      const status = error.reason === 'timeout' ? 'timed_out' : 'cancelled';
      await db
        .update(executions)
        .set({ status, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), error: error.message })
        .where(eq(executions.id, executionId));
      return;
    }

    const providerError = error instanceof ProviderError ? error : null;
    const transient = providerError && ['unavailable', 'rate_limited', 'timeout'].includes(providerError.code);
    if (transient && execution.attempt < MAX_ATTEMPTS) {
      await db
        .update(executions)
        .set({ status: 'queued', workerId: null, leaseExpiresAt: null, attempt: execution.attempt + 1, updatedAt: new Date(), error: redact(providerError.message, knownSecrets) })
        .where(eq(executions.id, executionId));
      await this.deps.boss.send(
        QUEUE_EXECUTION,
        { executionId },
        { startAfter: 30 * execution.attempt, singletonKey: `${executionId}:retry:${execution.attempt + 1}`, retryLimit: 0 },
      );
      return;
    }

    const message = redact(error instanceof Error ? error.message : String(error), knownSecrets).slice(0, 2_000);
    await db
      .update(executions)
      .set({ status: 'failed', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), error: message })
      .where(eq(executions.id, executionId));
  }

  private async loadSettings() {
    const { db } = this.deps;
    const rows = await db.execute<{ values: unknown }>(`select values from system_settings where id = 1`);
    return systemSettingsSchema.parse(rows.rows[0]?.values ?? {});
  }

  private searchProvider(settings: { searchProvider: string; searchBaseUrl: string }): SearchProvider {
    const baseUrl = this.deps.env.SEARXNG_URL ?? settings.searchBaseUrl;
    if (settings.searchProvider === 'none' || !baseUrl) return new NoopSearchProvider();
    return new SearxngSearchProvider({ baseUrl });
  }
}

export function parseTaskSchedule(value: unknown): ReturnType<typeof scheduleSchema.parse> {
  return scheduleSchema.parse(value);
}

/**
 * Whether the provider catalog explicitly marks the model as tool-capable. An
 * unknown model, an empty catalog or an undeclared capability is `false`: tool
 * support is never inferred.
 */
export function modelSupportsTools(config: unknown, model: string): boolean {
  if (!config || typeof config !== 'object') return false;
  return catalogModelSupportsTools((config as { models?: unknown }).models, model);
}

export async function loadUserTimezone(db: Database, userId: string): Promise<string> {
  const rows = await db.select({ timezone: userPreferences.timezone }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  return rows[0]?.timezone ?? 'Europe/Vienna';
}
