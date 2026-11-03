import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { PgBoss } from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@agent-tasks/database';
import {
  applyTaskLearning,
  executions,
  executionSources,
  executionSteps,
  loadMemoryContextData,
  providerCredentials,
  providers,
  tasks,
  user,
  userPreferences,
} from '@agent-tasks/database';
import { AgentCancelledError, runAgent } from '@agent-tasks/agent-runtime';
import type { RunAgentOptions, AgentRunResult } from '@agent-tasks/agent-runtime';
import { BrowserRunnerClient, NoopSearchProvider, SearxngSearchProvider } from '@agent-tasks/browser-tools';
import type { SearchProvider } from '@agent-tasks/browser-tools';
import { ProviderError, SecretBox, contextFor, createProvider, redact, resolveCredential } from '@agent-tasks/ai-providers';
import {
  AGENT_RUNTIME_LIMITS,
  buildMemoryContext,
  parseMemorySettings,
  renderEmailDocument,
  reportToMarkdown,
  scheduleSchema,
  systemSettingsSchema,
} from '@agent-tasks/shared';
import type { MemoryCategory, MemoryContextRecord, MemoryScope, RecommendationContextRecord } from '@agent-tasks/shared';
import { claimExecution, heartbeat, isCancelRequested } from './scheduling.js';
import { settleWithin } from './lifecycle.js';
import type { SettleResult } from './lifecycle.js';
import { resolveProviderConfig } from './codex-home.js';
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
  /** Explicit injection seam for experimental runtimes; production defaults to runAgent. */
  agentRunner?: (options: RunAgentOptions, lease: OpenCodeExecutionLease) => Promise<AgentRunResult>;
  /** Provisioned OpenCode runner; never fall back silently when the feature is enabled. */
  openCodeRunner?: (options: RunAgentOptions, lease: OpenCodeExecutionLease) => Promise<AgentRunResult>;
}

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;
/** How long a shutdown waits for aborted executions to settle before pg-boss takes over. */
export const SHUTDOWN_GRACE_MS = 25_000;

export class Executor {
  private readonly secrets: SecretBox;
  private readonly browser: BrowserRunnerClient;
  private readonly mailer: Mailer;
  private running = new Map<string, AbortController>();
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: ExecutorDeps) {
    if (deps.env.OPENCODE_RUNTIME_ENABLED === '1' && !deps.openCodeRunner) {
      throw new Error('OpenCode runtime enabled without an isolated execution provisioner');
    }
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
    for (const controller of this.running.values()) controller.abort();
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
        if (cancelled) abort.abort();
      });
      void heartbeat(db, executionId, LEASE_SECONDS);
    }, 2_000);

    const limits = AGENT_RUNTIME_LIMITS;
    let deadlineReached = false;
    const deadline = setTimeout(() => {
      deadlineReached = true;
      abort.abort();
    }, limits.maxDurationSec * 1_000);

    let browserSessionId: string | null = null;
    const knownSecrets: string[] = [];
    try {
      if (task.ownerId !== execution.ownerId) throw new Error('execution owner does not match task owner');
      const providerRows = await db.select().from(providers).where(eq(providers.id, task.providerId)).limit(1);
      const provider = providerRows[0];
      if (!provider) throw new Error('provider record no longer exists');
      if (!provider.enabled) throw new Error('provider is disabled');

      // `codex exec` can run arbitrary shell commands, and a per-user CODEX_HOME is only a
      // path convention, not a sandbox. Until an operator has isolated the runner itself,
      // a Codex execution must fail closed. `unsupported` is terminal (never retried).
      if (provider.kind === 'codex' && this.deps.env.CODEX_ISOLATED_RUNNER !== '1') {
        throw new ProviderError(
          'unsupported',
          'codex execution requires an isolated runner: set CODEX_ISOLATED_RUNNER=1 only after wiring per-user process isolation',
        );
      }

      const credentials = await db.select().from(providerCredentials).where(eq(providerCredentials.providerId, provider.id));
      const decrypt = (value: string): string => this.secrets.decrypt(value);
      const credential = resolveCredential(credentials, task.ownerId, decrypt);
      // Any credential on this provider may end up in an error message (e.g. a shared key
      // echoed while a personal key is resolved), so redact all of them, not just the one
      // used for this run.
      knownSecrets.push(...collectKnownSecrets(credential.apiKey, credentials, decrypt));

      // Codex logins are account-scoped: never use the directory stored on the global
      // provider row. Derive it from the task owner and create it owner-only.
      const resolvedConfig = resolveProviderConfig(provider.kind, provider.config as Record<string, unknown>, task.ownerId, this.deps.env.CODEX_HOME_ROOT);
      if (resolvedConfig.codexHome) await mkdir(resolvedConfig.codexHome, { recursive: true, mode: 0o700 });

      const adapter = createProvider(provider.kind);
      const providerContext = contextFor({ ...provider, config: resolvedConfig.config }, credential.apiKey);

      if (task.allowWebResearch) {
        const session = await this.browser.createSession();
        browserSessionId = session.sessionId;
      }

      const search = this.searchProvider(settings);
      const memorySettings = parseMemorySettings(task.memorySettings);
      // A model declared as non-tool-capable cannot receive memory tools. It can
      // still receive read-only context, but automatic learning is skipped.
      // Codex never executes tool calls, so it is treated the same way.
      const memoryToolsEnabled =
        memorySettings.mode !== 'off' &&
        provider.kind !== 'codex' &&
        modelSupportsTools(resolvedConfig.config, task.model);
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

      const runner = this.deps.env.OPENCODE_RUNTIME_ENABLED === '1'
        ? this.deps.openCodeRunner!
        : (this.deps.agentRunner ?? runAgent);
      const result = await runner({
        provider: adapter,
        providerContext,
        model: task.model,
        title: task.title,
        prompt: task.prompt,
        systemInstructions: task.systemInstructions,
        timezone: task.timezone,
        allowWebResearch: task.allowWebResearch,
        allowForms: false,
        emailNotification: task.notification === 'email',
        memoryEnabled: memoryToolsEnabled,
        memoryContext,
        limits,
        browser: this.browser,
        sessionId: browserSessionId ?? randomUUID(),
        search,
        signal: abort.signal,
        async onStep(step) {
          // A reconciled replay must not duplicate durable steps: the step number is
          // unique within an execution, so replace the row instead of appending.
          await db
            .delete(executionSteps)
            .where(and(eq(executionSteps.executionId, executionId), eq(executionSteps.step, step.step)));
          await db.insert(executionSteps).values({
            id: randomUUID(),
            executionId,
            step: step.step,
            tool: step.tool,
            args: step.arguments,
            ok: step.ok,
            startedAt: new Date(step.startedAt),
            finishedAt: new Date(step.finishedAt),
            durationMs: step.durationMs,
            error: step.error ? redact(step.error, knownSecrets).slice(0, 1_000) : null,
            resultPreview: step.resultPreview ?? null,
          });
        },
      }, { executionId, ownerId: execution.ownerId, workerId: this.deps.workerId });

      const finishedAt = new Date();
      await db
        .update(executions)
        .set({
          status: 'completed',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          report: {
            summary: result.summary,
            markdown: result.markdown,
            sources: result.sources,
            uncertainty: result.uncertainty,
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
      const markdown = reportToMarkdown(
        { summary: result.summary, markdown: result.markdown, sources: result.sources, uncertainty: result.uncertainty },
        { title: task.title, finishedAt: finishedAt.toISOString() },
      );
      await db.update(tasks).set({ lastRunAt: finishedAt }).where(eq(tasks.id, task.id));
      void markdown;

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

      if (task.notification === 'email') {
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
      // The runtime sees this controller as the caller's signal, so an abort caused by our
      // own deadline comes back as `AgentCancelledError('cancelled')`. Re-label it here:
      // a deadline is `timed_out`, never retried; a caller cancellation stays cancelled.
      const failure = deadlineReached && error instanceof AgentCancelledError && error.reason === 'cancelled' ? new AgentCancelledError('timeout') : error;
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
    result: Awaited<ReturnType<typeof runAgent>>;
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
 * Whether a configured model may receive tool definitions. Providers that do not
 * declare `supportsTools: false` are left unchanged; only an explicit false
 * disables the optional memory tools.
 */
export function modelSupportsTools(config: unknown, model: string): boolean {
  if (!config || typeof config !== 'object') return true;
  const models = (config as { models?: unknown }).models;
  if (!Array.isArray(models)) return true;
  const base = model.split(':')[0];
  const declared = models.find(
    (entry): entry is { id?: unknown; supportsTools?: unknown } =>
      typeof entry === 'object' && entry !== null && ((entry as { id?: unknown }).id === model || (entry as { id?: unknown }).id === base),
  );
  return declared?.supportsTools !== false;
}

export async function loadUserTimezone(db: Database, userId: string): Promise<string> {
  const rows = await db.select({ timezone: userPreferences.timezone }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  return rows[0]?.timezone ?? 'Europe/Vienna';
}
