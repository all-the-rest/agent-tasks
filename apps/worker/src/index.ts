import { randomUUID } from 'node:crypto';
import { createDatabase } from '@agent-tasks/database';
import { Executor, SHUTDOWN_GRACE_MS } from './executor.js';
import { loadWorkerEnv } from './env.js';
import { QUEUE_EXECUTION, QUEUE_RECOVERY, QUEUE_TICK, createBoss, executionWorkOptions } from './queues.js';
import { recoverStaleExecutions, resendQueuedExecutions, scheduleDueExecutions } from './scheduling.js';
import { OpenCodeSessionStore } from './opencode-session-store.js';
import { createIsolatedOpenCodeRunner } from './opencode-isolated-runtime.js';
import { createToolBridgeHub } from './opencode-tool-bridge.js';
import { HttpOpenCodeProvisioner } from './http-opencode-provisioner.js';

const env = loadWorkerEnv();
const workerId = env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
if (env.OPENCODE_RUNTIME_ENABLED === '1' && !env.OPENCODE_PROVISIONER_TOKEN) {
  throw new Error('OPENCODE_PROVISIONER_TOKEN is required when OPENCODE_RUNTIME_ENABLED=1');
}
const database = createDatabase(env.DATABASE_URL, { max: 4 });
const boss = await createBoss(env.DATABASE_URL);
// One hub per worker process; each execution registers its own token and budget.
// The provisioner proxies the runtime's MCP traffic to this port on the internal
// network, so it is never published.
const toolBridgeHub = env.OPENCODE_RUNTIME_ENABLED === '1'
  ? await createToolBridgeHub({ port: 4091 })
  : undefined;
const openCodeRunner = env.OPENCODE_RUNTIME_ENABLED === '1'
  ? createIsolatedOpenCodeRunner(
      new HttpOpenCodeProvisioner(env.OPENCODE_PROVISIONER_URL, env.OPENCODE_PROVISIONER_TOKEN!),
      new OpenCodeSessionStore(database.db),
      toolBridgeHub,
    )
  : undefined;
const executor = new Executor({ db: database.db, env, boss, workerId, openCodeRunner });

const log = (event: string, extra: Record<string, unknown> = {}): void => {
  console.info(JSON.stringify({ level: 'info', event, workerId, ...extra }));
};

/** A fresh job for an execution row; `singletonKey` only records why it was sent. */
const enqueueExecution = (executionId: string, source: string): Promise<string | null> =>
  boss.send(QUEUE_EXECUTION, { executionId }, { singletonKey: `${executionId}:${source}:${Date.now()}`, retryLimit: 0, expireInSeconds: 3_600 });

// The tick and the recovery sweep are declared in pg-boss itself, so they survive a
// worker restart; the watchdog below re-arms them if the schedule table is empty.
await boss.schedule(QUEUE_TICK, '* * * * *', {}, { tz: 'UTC' });
await boss.schedule(QUEUE_RECOVERY, '*/2 * * * *', {}, { tz: 'UTC' });

await boss.work<{ executionId: string }>(QUEUE_EXECUTION, executionWorkOptions(env.WORKER_CONCURRENCY), async (jobs) => {
  for (const job of jobs) {
    try {
      await executor.handle(job.data.executionId);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'execution_crashed', executionId: job.data.executionId, message: (error as Error).message }));
      // Let pg-boss retry the delivery; the execution row keeps its own attempt count.
      throw error;
    }
  }
});

await boss.work(QUEUE_TICK, { batchSize: 1 }, async () => {
  const created = await scheduleDueExecutions(database.db);
  for (const item of created) {
    await enqueueExecution(item.executionId, 'scheduled');
  }
  if (created.length > 0) log('scheduled', { count: created.length });
});

await boss.work(QUEUE_RECOVERY, { batchSize: 1 }, async () => {
  const recovered = await recoverStaleExecutions(database.db);
  for (const executionId of recovered.requeued) {
    await enqueueExecution(executionId, 'recovered');
  }
  // Rows committed by the scheduler (or requeued by a failed run) whose `boss.send` never
  // landed would otherwise stay `queued` forever. The sweep is paginated and idempotent:
  // a worker claims the row at most once, and an execution that is still queued after
  // `QUEUED_SWEEP_MIN_AGE_SECONDS` is sent again on the next tick.
  const resent = await resendQueuedExecutions(database.db, (executionId) => enqueueExecution(executionId, 'sweep'));
  if (recovered.requeued.length > 0 || recovered.cancelled.length > 0) log('recovered', recovered);
  if (resent.attempted > 0) log('queued_executions_resent', { source: 'recovery', attempted: resent.attempted, failed: resent.failed.length });
});

// Anything that was queued while the worker was down is picked up immediately through the
// same paginated path, but with no minimum age: every queued row is a boot candidate.
const bootResend = await resendQueuedExecutions(database.db, (executionId) => enqueueExecution(executionId, 'boot'), { olderThanSeconds: 0 });
if (bootResend.attempted > 0) log('queued_executions_resent', { source: 'boot', attempted: bootResend.attempted, failed: bootResend.failed.length });

log('worker_started', { concurrency: env.WORKER_CONCURRENCY, queues: [QUEUE_EXECUTION, QUEUE_TICK, QUEUE_RECOVERY] });

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  const activeAtStart = executor.activeExecutions;
  log('shutdown_started', { signal, active: activeAtStart });
  // abortAll signals every running execution and waits for the promises to settle, so the
  // log below describes what actually happened instead of what was merely requested.
  const drained = await executor.abortAll(SHUTDOWN_GRACE_MS);
  if (drained.settled) log('shutdown_drained', { signal, activeAtStart, pending: 0 });
  else log('shutdown_grace_expired', { signal, activeAtStart, pending: drained.pending });
  await boss.stop({ graceful: true });
  await toolBridgeHub?.close();
  await database.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
