import { describe, expect, it } from 'vitest';
import type { WorkOptions } from 'pg-boss';
import { executionWorkOptions } from '../src/queues.js';

describe('execution worker options', () => {
  it('applies WORKER_CONCURRENCY through pg-boss v12 localConcurrency', () => {
    // `WorkOptions` has no `teamSize`/`teamConcurrency` in pg-boss 12; `localConcurrency`
    // is the per-node worker count and `batchSize: 1` keeps one execution per worker.
    const options: WorkOptions = executionWorkOptions(4);
    expect(options).toEqual({ batchSize: 1, pollingIntervalSeconds: 1, localConcurrency: 4 });
  });

  it('keeps a single execution worker at concurrency 1', () => {
    expect(executionWorkOptions(1).localConcurrency).toBe(1);
  });
});
