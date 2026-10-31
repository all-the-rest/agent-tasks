/**
 * Why this exists: signalling an abort only tells a handler to stop, it does not wait for
 * it. A shutdown log printed right after `controller.abort()` would claim "shutdown" while
 * executions were still writing rows. This helper waits for the in-flight promises with a
 * bounded grace period so the log can state what actually settled.
 */
export interface SettleResult {
  /** True when every promise given had settled before the deadline. */
  settled: boolean;
  /** Number of promises still pending when the deadline expired (0 when settled). */
  pending: number;
}

export async function settleWithin(promises: Iterable<Promise<unknown>>, timeoutMs: number): Promise<SettleResult> {
  const snapshot = [...promises];
  if (snapshot.length === 0) return { settled: true, pending: 0 };

  let settledCount = 0;
  const tracked = snapshot.map((promise) =>
    promise.then(
      () => {
        settledCount += 1;
      },
      () => {
        // A rejected execution is still settled: the executor records its own failure.
        settledCount += 1;
      },
    ),
  );

  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race<'settled' | 'timeout'>([
    Promise.all(tracked).then(() => 'settled' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    }),
  ]);
  clearTimeout(timer);

  const pending = snapshot.length - settledCount;
  return { settled: outcome === 'settled', pending };
}
