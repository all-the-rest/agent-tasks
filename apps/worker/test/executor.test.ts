import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor.js';
import type { WorkerEnv } from '../src/env.js';

const env: WorkerEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  RUNNER_URL: 'http://127.0.0.1:1',
  RUNNER_TOKEN: 'unit-test-runner-token',
  WORKER_CONCURRENCY: 1,
  CODEX_HOME_ROOT: '/var/lib/agent-tasks/codex',
  CODEX_ISOLATED_RUNNER: '0',
  LOG_LEVEL: 'silent',
};

function makeExecutor(): Executor {
  return new Executor({ db: {} as never, env, boss: {} as never, workerId: 'unit-worker' });
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

describe('OpenCode feature gate', () => {
  it('fails closed when enabled without a provisioned runtime', () => {
    expect(() => new Executor({ db: {} as never, env: { ...env, OPENCODE_RUNTIME_ENABLED: '1' }, boss: {} as never, workerId: 'unit-worker' }))
      .toThrow('without an isolated execution provisioner');
    expect(() => makeExecutor()).not.toThrow();
  });
});
