import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import type { Database } from '@agent-tasks/database';
import { executions, executionSources, executionSteps, providerCredentials, providers, tasks, userPreferences } from '@agent-tasks/database';
import { AgentCancelledError, runAgent } from '@agent-tasks/agent-runtime';
import { BrowserRunnerClient, NoopSearchProvider, SearxngSearchProvider } from '@agent-tasks/browser-tools';
import type { SearchProvider } from '@agent-tasks/browser-tools';
import { ProviderError, SecretBox, contextFor, createProvider, redact, resolveCredential } from '@agent-tasks/ai-providers';
import { limitsSchema, reportToMarkdown, scheduleSchema, systemSettingsSchema } from '@agent-tasks/shared';
import { claimExecution, countExecutionsToday, countRunningForOwner, heartbeat, isCancelRequested } from './scheduling.js';
import { settleWithin } from './lifecycle.js';
import type { SettleResult } from './lifecycle.js';
import { exceededExecutionLimit } from './quota.js';
import { resolveProviderConfig } from './codex-home.js';
import { collectKnownSecrets } from './credentials.js';
import { QUEUE_EXECUTION } from './queues.js';
import type { WorkerEnv } from './env.js';

export interface ExecutorDeps {
  db: Database;
  env: WorkerEnv;
  boss: PgBoss;
  workerId: string;
}

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;
/** How long a shutdown waits for aborted executions to settle before pg-boss takes over. */
export const SHUTDOWN_GRACE_MS = 25_000;

export class Executor {
  private readonly secrets: SecretBox;
  private readonly browser: BrowserRunnerClient;
  private running = new Map<string, AbortController>();
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: ExecutorDeps) {
    this.secrets = new SecretBox(deps.env.SECRETS_ENCRYPTION_KEY, deps.env.SECRETS_ENCRYPTION_KEY_PREVIOUS);
    this.browser = new BrowserRunnerClient({ baseUrl: deps.env.RUNNER_URL, token: deps.env.RUNNER_TOKEN, timeoutMs: 60_000 });
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
    const claimed = await claimExecution(db, executionId, this.deps.workerId, LEASE_SECONDS);
    if (!claimed) {
      // Another worker already owns it, or the execution is no longer queued.
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

    const settings = await this.loadSettings();

    if (await isCancelRequested(db, executionId)) {
      await db.update(executions).set({ status: 'cancelled', finishedAt: new Date(), error: 'cancel requested before start' }).where(eq(executions.id, executionId));
      return;
    }

    // `execution` itself is already `running` and its row already exists, so both counts
    // exclude it; the helper refuses this execution when the limits are already reached.
    const budget = {
      priorExecutionsToday: await countExecutionsToday(db, execution.ownerId, executionId),
      otherRunningForOwner: await countRunningForOwner(db, execution.ownerId, executionId),
    };
    const refusal = exceededExecutionLimit(budget, settings);
    if (refusal) {
      if (execution.attempt >= MAX_ATTEMPTS) {
        await db
          .update(executions)
          .set({ status: 'failed', finishedAt: new Date(), error: refusal === 'quota' ? 'daily execution quota exceeded' : 'per-user concurrency limit exceeded' })
          .where(eq(executions.id, executionId));
        return;
      }
      await db
        .update(executions)
        .set({ status: 'queued', workerId: null, leaseExpiresAt: null, attempt: execution.attempt + 1, updatedAt: new Date() })
        .where(eq(executions.id, executionId));
      await this.deps.boss.send(QUEUE_EXECUTION, { executionId }, { startAfter: 30, singletonKey: `${executionId}:${execution.attempt + 1}`, retryLimit: 0 });
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

    const limits = limitsSchema.parse(task.limits);
    let deadlineReached = false;
    const deadline = setTimeout(() => {
      deadlineReached = true;
      abort.abort();
    }, limits.maxDurationSec * 1_000);

    let browserSessionId: string | null = null;
    const knownSecrets: string[] = [];
    try {
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
      const result = await runAgent({
        provider: adapter,
        providerContext,
        model: task.model,
        title: task.title,
        prompt: task.prompt,
        systemInstructions: task.systemInstructions,
        timezone: task.timezone,
        allowWebResearch: task.allowWebResearch,
        allowForms: false,
        limits,
        browser: this.browser,
        sessionId: browserSessionId ?? randomUUID(),
        search,
        signal: abort.signal,
        async onStep(step) {
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
      });

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

export async function loadUserTimezone(db: Database, userId: string): Promise<string> {
  const rows = await db.select({ timezone: userPreferences.timezone }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  return rows[0]?.timezone ?? 'Europe/Vienna';
}
