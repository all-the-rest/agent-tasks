import { describe, expect, it } from 'vitest';
import { Executor, modelSupportsTools } from '../src/executor.js';
import type { WorkerEnv } from '../src/env.js';

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
