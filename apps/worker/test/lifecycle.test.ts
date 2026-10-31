import { describe, expect, it } from 'vitest';
import { settleWithin } from '../src/lifecycle.js';

describe('shutdown waiter', () => {
  it('is trivially settled when nothing is in flight', async () => {
    await expect(settleWithin([], 1_000)).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('waits until the in-flight executions settle', async () => {
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 20));
    await expect(settleWithin([slow], 1_000)).resolves.toEqual({ settled: true, pending: 0 });
  });

  it('returns after the grace period and reports what is still pending', async () => {
    const never = new Promise<void>(() => undefined);
    const done = Promise.resolve();
    const result = await settleWithin([never, done], 10);
    expect(result.settled).toBe(false);
    expect(result.pending).toBe(1);
  });

  it('treats a rejected execution as settled, because it records its own failure', async () => {
    const failed = Promise.reject(new Error('execution failed'));
    await expect(settleWithin([failed], 1_000)).resolves.toEqual({ settled: true, pending: 0 });
  });
});
