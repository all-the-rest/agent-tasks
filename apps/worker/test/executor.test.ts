import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executionSteps, executions, providerCredentials, providerModels, providers } from '@agent-tasks/database';
import type { AgentRunResult, RunAgentOptions } from '@agent-tasks/agent-runtime';
import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import { SecretBox, ProviderError } from '@agent-tasks/ai-providers';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { Executor, classifyExecutionFailure, getExecutionAbortReason, modelSupportsTools, providerHeaderSecrets } from '../src/executor.js';
import type { WorkerEnv } from '../src/env.js';
import { QUEUE_EXECUTION } from '../src/queues.js';

const env: WorkerEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  RUNNER_URL: 'http://127.0.0.1:1',
  RUNNER_TOKEN: 'unit-test-runner-token',
  WORKER_CONCURRENCY: 1,
  OPENCODE_PROVISIONER_URL: 'http://opencode-provisioner:4090',
  OPENCODE_PROVISIONER_TOKEN: 'unit-test-provisioner-token-0123456789',
  LOG_LEVEL: 'silent',
};

function makeExecutor(): Executor {
  return new Executor({ db: {} as never, env, boss: {} as never, workerId: 'unit-worker', openCodeRunner: async () => { throw new Error('not used'); } });
}

interface ExecutorInternals {
  running: Map<string, AbortController>;
  inFlight: Set<Promise<void>>;
}

function internals(executor: Executor): ExecutorInternals {
  return executor as unknown as ExecutorInternals;
}

describe('executor shutdown', () => {
  it('is settled immediately when no execution is running', async () => {
    await expect(makeExecutor().abortAll(1_000)).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('aborts the running controllers and waits for their executions to settle', async () => {
    const executor = makeExecutor();
    const controller = new AbortController();
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    internals(executor).running.set('execution-1', controller);
    internals(executor).inFlight.add(inFlight);

    const drained = executor.abortAll(1_000);
    expect(controller.signal.aborted).toBe(true);
    release();

    await expect(drained).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('reports an execution that ignores the abort instead of hanging the shutdown', async () => {
    const executor = makeExecutor();
    internals(executor).running.set('execution-1', new AbortController());
    internals(executor).inFlight.add(new Promise<void>(() => undefined));

    await expect(executor.abortAll(10)).resolves.toEqual({ settled: false, pending: 1 });
  });
});

describe('tool capability', () => {
  it('never infers tool support without an explicit catalog declaration', () => {
    expect(modelSupportsTools({ models: [{ id: 'model-a', supportsTools: true }] }, 'model-a')).toBe(true);
    expect(modelSupportsTools({ models: [{ id: 'model-a', supportsTools: true }] }, 'model-a#high')).toBe(true);
    expect(modelSupportsTools({ models: [{ id: 'model-a' }] }, 'model-a')).toBe(false);
    expect(modelSupportsTools({ models: [] }, 'model-a')).toBe(false);
    expect(modelSupportsTools({}, 'model-a')).toBe(false);
    expect(modelSupportsTools(undefined, 'model-a')).toBe(false);
  });
});

describe('isolated OpenCode requirement', () => {
  it('fails closed without a provisioned runner', () => {
    expect(() => new Executor({ db: {} as never, env, boss: {} as never, workerId: 'unit-worker', openCodeRunner: undefined } as never))
      .toThrow('Isolated OpenCode execution provisioner is required');
    expect(() => makeExecutor()).not.toThrow();
  });
});

const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));
const ownerId = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const HEADER_SECRET = 'provider-header-secret-123';
const CREDENTIAL_SECRET = 'fake-provider-key';

describe('provider header redaction selection', () => {
  it('redacts credential-like header values without treating ordinary metadata as a secret', () => {
    expect(providerHeaderSecrets({
      headers: {
        Authorization: 'Bearer sensitive-token',
        'X-API-Key': 'provider-api-key',
        'X-Title': 'Agent Tasks',
        'OpenAI-Organization': 'research-team',
      },
    })).toEqual(['Bearer sensitive-token', 'provider-api-key']);
    expect(providerHeaderSecrets({ headers: 'not-an-object' })).toEqual([]);
  });
});

interface StepRow {
  id: string;
  executionId: string;
  step: number;
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: string | null;
  resultPreview?: string | null;
}

function executionFixture(options: {
  attempt?: number;
  steps?: StepRow[];
  agentLimits?: Record<string, number>;
  conversationMode?: 'standalone' | 'conversation';
  inputSnapshot?: string;
  otherRunningForTask?: number;
  priorTurns?: Array<{ id: string; status: string; inputSnapshot: string; report: { markdown: string } | null }>;
} = {}) {
  const executionId = options.steps?.[0]?.executionId ?? randomUUID();
  const task = {
    id: randomUUID(),
    providerId: randomUUID(),
    ownerId,
    title: 'Timeout task',
    prompt: 'Wait for the provider',
    conversationMode: options.conversationMode ?? 'standalone',
    systemInstructions: null,
    timezone: 'Europe/Vienna',
    model: 'mock-model',
    allowWebResearch: false,
    notification: { email: { enabled: false, when: 'always' } },
    memorySettings: { mode: 'off' },
    limits: AGENT_RUNTIME_LIMITS,
  };
  const provider = {
    id: task.providerId,
    name: 'Test provider',
    kind: 'openai-compatible',
    enabled: true,
    config: {
      baseUrl: 'https://provider.invalid/v1',
      models: [{ id: 'mock-model', supportsTools: true }],
      headers: { authorization: HEADER_SECRET },
    },
  };
  const execution = { id: executionId, ownerId, attempt: options.attempt ?? 0, inputSnapshot: options.inputSnapshot ?? task.prompt };
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const stepRows: StepRow[] = [...(options.steps ?? [])];
  const stepInserts: StepRow[] = [];
  const stepDeletes: Array<{ sql: string; params: unknown[] }> = [];
  let executionSelectCount = 0;
  const dialect = new PgDialect();
  const execute = async (query: unknown) => {
    const sql = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
    if (sql.includes('from system_settings')) return { rows: [{ values: { agentLimits: options.agentLimits ?? {} } }] };
    if (sql.includes('select owner_id, task_id, attempt')) return { rows: [{ owner_id: ownerId, task_id: task.id, attempt: 0, already_admitted_today: false }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('prior_executions_today')) return { rows: [{
      prior_executions_today: 0,
      other_running_for_owner: 0,
      other_running_for_task: options.otherRunningForTask ?? 0,
    }] };
    if (sql.includes("set status = 'running'")) return { rows: [] };
    if (sql.includes('set lease_expires_at')) return { rows: [] };
    if (sql.includes('select cancel_requested')) return { rows: [{ cancel_requested: false }] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const chain = (value: unknown) => {
    const builder: Record<string, unknown> = {};
    builder.innerJoin = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = async () => value;
    builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
    return builder;
  };
  const db = {
    execute,
    transaction: async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }),
    select: () => ({
      from(table: unknown) {
        if (table === providers) return chain([provider]);
        if (table === executions) {
          executionSelectCount += 1;
          if (executionSelectCount === 1) return chain([{ execution, task }]);
          if (task.conversationMode === 'conversation' && executionSelectCount === 2) return chain(options.priorTurns ?? []);
          return chain([]);
        }
        if (table === providerCredentials) return chain([{ ownerId: null, ciphertext: box.encrypt('fake-provider-key') }]);
        if (table === providerModels) return chain([]);
        if (table === executionSteps) return chain(stepRows);
        throw new Error('unexpected select table');
      },
    }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }) }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        if (table !== executionSteps) return;
        const query = dialect.sqlToQuery(condition as never);
        stepDeletes.push({ sql: query.sql, params: query.params });
        const ids = new Set(query.params.filter((value): value is string => typeof value === 'string'));
        for (let index = stepRows.length - 1; index >= 0; index -= 1) {
          if (ids.has(stepRows[index]!.id)) stepRows.splice(index, 1);
        }
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: StepRow) => {
        if (table !== executionSteps) return;
        stepInserts.push(values);
        stepRows.push(values);
      },
    }),
  };
  return { db: db as never, updates, executionId, stepRows, stepInserts, stepDeletes };
}

function executorFor(
  fixture: ReturnType<typeof executionFixture>,
  openCodeRunner: (options: RunAgentOptions) => Promise<AgentRunResult>,
) {
  const send = vi.fn(async () => 'job-id');
  const executor = new Executor({
    db: fixture.db,
    env,
    boss: { send } as never,
    workerId: 'unit-worker',
    openCodeRunner,
  });
  return { executor, send };
}

function executionStatus(updates: ReturnType<typeof executionFixture>['updates']): unknown {
  return updates.filter((entry) => entry.table === executions).at(-1)?.values.status;
}

const completedResult: AgentRunResult = {
  markdown: 'Done.',
  summary: 'Done.',
  sources: [],
  uncertainty: [],
  steps: [],
  usage: {},
  emailBlocks: [],
  memoryOps: [],
  recommendationOps: [],
  stopReason: 'completed',
};

describe('execution timeline persistence', () => {
  it('requeues a same-task execution after transient contention without spending an attempt', async () => {
    const fixture = executionFixture({ otherRunningForTask: 1 });
    const { executor, send } = executorFor(fixture, async () => {
      throw new Error('a deferred execution must not run');
    });

    await executor.handle(fixture.executionId);

    expect(send).toHaveBeenCalledWith(QUEUE_EXECUTION, { executionId: fixture.executionId }, {
      startAfter: 30,
      singletonKey: expect.stringMatching(new RegExp(`^${fixture.executionId}:task-busy:\\d+$`)),
      retryLimit: 0,
    });
    expect(executionStatus(fixture.updates)).toBeUndefined();
  });

  it('passes the immutable execution input with bounded completed conversation context', async () => {
    const fixture = executionFixture({
      conversationMode: 'conversation',
      inputSnapshot: 'What changed since yesterday?',
      priorTurns: [{
        id: 'previous-run',
        status: 'completed',
        inputSnapshot: 'Summarize yesterday.',
        report: { markdown: 'Yesterday’s findings.' },
      }],
    });
    let observed: RunAgentOptions | undefined;
    const { executor } = executorFor(fixture, async (options) => {
      observed = options;
      return completedResult;
    });

    await executor.handle(fixture.executionId);

    expect(observed?.prompt).toBe('What changed since yesterday?');
    expect(JSON.parse(observed?.conversationContext ?? '[]')).toEqual([
      { user: 'Summarize yesterday.', assistant: 'Yesterday’s findings.' },
    ]);
  });

  it('uses validated administrator limits rather than task-owned limit values', async () => {
    const fixture = executionFixture({ agentLimits: {
      maxDurationSec: 45,
      maxAgentSteps: 7,
      maxPageVisits: 2,
      maxOutputBytes: 20_000,
      maxToolCalls: 9,
      maxSearchQueries: 3,
    } });
    let observed: RunAgentOptions | undefined;
    const { executor } = executorFor(fixture, async (options) => {
      observed = options;
      return completedResult;
    });

    await executor.handle(fixture.executionId);

    expect(observed?.limits).toEqual({
      maxDurationSec: 45,
      maxAgentSteps: 7,
      maxPageVisits: 2,
      maxOutputBytes: 20_000,
      maxToolCalls: 9,
      maxSearchQueries: 3,
    });
    const internal = observed as (RunAgentOptions & {
      executionBudget?: { reserveBudget(counters: Partial<Record<'calls' | 'pages' | 'searches' | 'outputBytes', number>>): Promise<unknown> };
    }) | undefined;
    expect(internal?.executionBudget?.reserveBudget).toBeTypeOf('function');
  });

  it('redacts and caps every persisted step field, including config header values', async () => {
    const fixture = executionFixture();
    const { executor } = executorFor(fixture, async (options) => {
      await options.onStep?.({
        step: 1,
        tool: `search_web-${HEADER_SECRET}`,
        arguments: {
          query: HEADER_SECRET,
          credential: CREDENTIAL_SECRET,
          nested: { token: 'sk-abcdefghijklmnop' },
          arbitrary_secret: 'user-supplied-secret-value',
          long: 'x'.repeat(5_000),
          list: [HEADER_SECRET, 'public'],
        },
        ok: false,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        durationMs: 1,
        error: `failed with ${HEADER_SECRET} and ${CREDENTIAL_SECRET}`,
        resultPreview: `preview ${HEADER_SECRET} ${'y'.repeat(5_000)}`,
      });
      await options.onStep?.({
        step: 2,
        tool: 'opencode',
        arguments: { model: 'mock-model', echoed: HEADER_SECRET },
        ok: true,
        startedAt: new Date(2).toISOString(),
        finishedAt: new Date(3).toISOString(),
        durationMs: 1,
        resultPreview: `answer ${HEADER_SECRET}`,
      });
      return completedResult;
    });

    await executor.handle(fixture.executionId);

    expect(fixture.stepInserts).toHaveLength(2);
    const [toolStep, synthetic] = fixture.stepInserts;
    expect(toolStep).toMatchObject({ step: 1, tool: 'search_web-[redacted]', ok: false, durationMs: 1 });
    expect(toolStep?.args).toMatchObject({
      query: '[redacted]',
      credential: '[redacted]',
      nested: { token: '[redacted]' },
      arbitrary_secret: '[redacted]',
      list: ['[redacted]', 'public'],
    });
    expect((toolStep?.args?.long as string).length).toBe(1_000);
    expect(toolStep?.error).toContain('[redacted]');
    expect(toolStep?.error).not.toContain(HEADER_SECRET);
    expect(toolStep?.resultPreview).toContain('[redacted]');
    expect(toolStep?.resultPreview?.length).toBeLessThanOrEqual(1_000);
    expect(synthetic).toMatchObject({ step: 2, tool: 'opencode', args: { model: 'mock-model', echoed: '[redacted]' } });
    expect(synthetic?.resultPreview).toBe('answer [redacted]');

    const persisted = JSON.stringify(fixture.stepInserts);
    expect(persisted).not.toContain(HEADER_SECRET);
    expect(persisted).not.toContain(CREDENTIAL_SECRET);
    expect(persisted).not.toContain('sk-abcdefghijklmnop');
  });

  it('never copies memory bodies into step history', async () => {
    const fixture = executionFixture();
    const { executor } = executorFor(fixture, async (options) => {
      await options.onStep?.({
        step: 1,
        tool: 'record_task_memory',
        arguments: { category: 'finding', content: 'private memory body', semanticKey: 'finding.private' },
        ok: true,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        durationMs: 1,
        resultPreview: 'queued task memory: finding',
      });
      await options.onStep?.({
        step: 2,
        tool: 'track_recommendation',
        arguments: {
          stableKey: 'offer/alpha',
          title: 'Private offer title',
          description: 'Private description',
          metadata: { price: 42 },
          status: 'recommended',
        },
        ok: true,
        startedAt: new Date(2).toISOString(),
        finishedAt: new Date(3).toISOString(),
        durationMs: 1,
      });
      return completedResult;
    });

    await executor.handle(fixture.executionId);

    expect(fixture.stepInserts.map((step) => step.args)).toEqual([{ redacted: true }, { redacted: true }]);
    expect(JSON.stringify(fixture.stepInserts)).not.toContain('private memory body');
    expect(JSON.stringify(fixture.stepInserts)).not.toContain('Private offer title');
  });

  it('redacts provider header values from terminal execution errors', async () => {
    const fixture = executionFixture();
    const { executor } = executorFor(fixture, async () => {
      throw new Error(`gateway echoed ${HEADER_SECRET}`);
    });

    await executor.handle(fixture.executionId);

    const failed = fixture.updates.find((entry) => entry.table === executions && entry.values.status === 'failed');
    expect(failed?.values.error).toBe(`gateway echoed [redacted]`);
    expect(String(failed?.values.error)).not.toContain(HEADER_SECRET);
  });

  it('retires steps of earlier attempts but keeps and extends a resumed attempt', async () => {
    const executionId = randomUUID();
    const resumed = executionFixture({
      attempt: 2,
      steps: [
        { id: 'stale', executionId, step: 5, tool: 'search_web' },
        { id: 'live', executionId, step: 1_000_002, tool: 'open_url' },
        { id: 'old-synthetic', executionId, step: 1_000_003, tool: 'opencode' },
      ],
    });
    const first = executorFor(resumed, async (options) => {
      await options.onStep?.({
        step: 1,
        tool: 'search_web',
        arguments: { query: 'resumed' },
        ok: true,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        durationMs: 1,
      });
      await options.onStep?.({
        step: 2,
        tool: 'opencode',
        arguments: { model: 'mock-model' },
        ok: true,
        startedAt: new Date(2).toISOString(),
        finishedAt: new Date(3).toISOString(),
        durationMs: 1,
      });
      return completedResult;
    });
    await first.executor.handle(resumed.executionId);

    const ids = new Set(resumed.stepRows.map((row) => row.id));
    expect(ids.has('stale')).toBe(false);
    expect(ids.has('live')).toBe(true);
    expect(ids.has('old-synthetic')).toBe(false);
    expect(resumed.stepInserts.map((row) => [row.step, row.tool])).toEqual([
      [1_000_004, 'search_web'],
      [1_000_005, 'opencode'],
    ]);
    expect(new Set(resumed.stepRows.map((row) => row.step)).size).toBe(resumed.stepRows.length);

    // A crash recovery of the same attempt has no earlier segment to purge and
    // appends the recovered synthetic summary instead of replacing a tool row.
    const crashExecution = randomUUID();
    const crash = executionFixture({
      attempt: 2,
      steps: [{ id: 'same-attempt', executionId: crashExecution, step: 1_000_002, tool: 'open_url' }],
    });
    const second = executorFor(crash, async (options) => {
      await options.onStep?.({
        step: 1,
        tool: 'opencode',
        arguments: { model: 'mock-model' },
        ok: true,
        startedAt: new Date(4).toISOString(),
        finishedAt: new Date(5).toISOString(),
        durationMs: 1,
      });
      return completedResult;
    });
    await second.executor.handle(crash.executionId);
    expect(crash.stepRows.map((row) => row.id)).toContain('same-attempt');
    expect(crash.stepInserts.map((row) => [row.step, row.tool])).toEqual([[1_000_003, 'opencode']]);
  });

  it('serialises concurrent step writes with distinct numbers', async () => {
    const fixture = executionFixture();
    const { executor } = executorFor(fixture, async (options) => {
      await Promise.all([1, 2, 3].map((step) => options.onStep?.({
        step,
        tool: 'add_email_block',
        arguments: { index: step },
        ok: true,
        startedAt: new Date(step).toISOString(),
        finishedAt: new Date(step + 1).toISOString(),
        durationMs: 1,
      })));
      return completedResult;
    });

    await executor.handle(fixture.executionId);

    expect(fixture.stepInserts.map((row) => row.step)).toEqual([1, 2, 3]);
    expect(fixture.stepInserts.map((row) => row.args?.index)).toEqual([1, 2, 3]);
  });
});

describe('execution abort classification', () => {
  it('separates deadline, cancellation and bare aborts', () => {
    const deadline = new AbortController();
    const cancelled = new AbortController();
    const shutdown = new AbortController();
    deadline.abort('timeout');
    cancelled.abort('cancelled');
    shutdown.abort();

    expect(getExecutionAbortReason(new AbortController().signal)).toBeNull();
    expect(getExecutionAbortReason(deadline.signal)).toBe('timeout');
    expect(getExecutionAbortReason(cancelled.signal)).toBe('cancelled');
    expect(getExecutionAbortReason(shutdown.signal)).toBe('cancelled');
  });

  it('maps any pre-completion failure after an abort to a non-retryable cancellation', () => {
    const timeout = classifyExecutionFailure(new ProviderError('timeout', 'upstream timed out'), 'timeout');
    const cancelled = classifyExecutionFailure(new Error('provisioning failed'), 'cancelled');

    expect(timeout).toBeInstanceOf(AgentCancelledError);
    expect((timeout as AgentCancelledError).reason).toBe('timeout');
    expect(cancelled).toBeInstanceOf(AgentCancelledError);
    expect((cancelled as AgentCancelledError).reason).toBe('cancelled');
    // Without an abort, a real provider timeout keeps its retryable classification.
    const providerTimeout = new ProviderError('timeout', 'upstream timed out');
    expect(classifyExecutionFailure(providerTimeout, null)).toBe(providerTimeout);
  });

  it('retries a genuine provider timeout when the execution was not aborted', async () => {
    const fixture = executionFixture();
    const { executor, send } = executorFor(fixture, async () => {
      throw new ProviderError('timeout', 'upstream timed out');
    });

    await executor.handle(fixture.executionId);

    expect(executionStatus(fixture.updates)).toBe('queued');
    expect(fixture.updates.at(-1)?.values).toMatchObject({ attempt: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not retry a retryable provider error that arrives after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fixture = executionFixture();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const { executor, send } = executorFor(fixture, async (options) => {
        markStarted();
        await new Promise<never>((_, reject) => {
          options.signal?.addEventListener('abort', () => reject(new ProviderError('timeout', 'upstream timed out')), { once: true });
        });
      });

      const handled = executor.handle(fixture.executionId);
      await started;
      await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_LIMITS.maxDurationSec * 1_000);
      await handled;

      expect(executionStatus(fixture.updates)).toBe('timed_out');
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a retryable provider error that arrives after user cancellation', async () => {
    const fixture = executionFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const { executor, send } = executorFor(fixture, async (options) => {
      markStarted();
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new ProviderError('rate_limited', 'provider rate limit reached')), { once: true });
      });
    });

    const handled = executor.handle(fixture.executionId);
    await started;
    await executor.abortAll(1_000);
    await handled;

    expect(executionStatus(fixture.updates)).toBe('cancelled');
    expect(send).not.toHaveBeenCalled();
  });
});
