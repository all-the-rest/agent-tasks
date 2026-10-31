import { PgBoss } from 'pg-boss';
import type { WorkOptions } from 'pg-boss';

export const QUEUE_EXECUTION = 'execution-run';
export const QUEUE_TICK = 'scheduler-tick';
export const QUEUE_RECOVERY = 'scheduler-recovery';

/**
 * pg-boss v12 concurrency: `localConcurrency` is the number of workers spawned for this
 * queue on this node (the replacement for the removed `teamSize`/`teamConcurrency`), and
 * each worker fetches one job because `batchSize` stays 1. `WORKER_CONCURRENCY = N` thus
 * means N executions in parallel per worker process. The tick and recovery queues keep
 * their default `localConcurrency` of 1.
 */
export function executionWorkOptions(concurrency: number): WorkOptions {
  return { batchSize: 1, pollingIntervalSeconds: 1, localConcurrency: concurrency };
}

export async function createBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    max: 3,
    application_name: 'agent-tasks-worker',
    supervise: true,
    schedule: true,
  });
  boss.on('error', (error: Error) => {
    console.error(JSON.stringify({ level: 'error', event: 'pgboss_error', message: error.message }));
  });
  await boss.start();
  await boss.createQueue(QUEUE_EXECUTION);
  await boss.createQueue(QUEUE_TICK);
  await boss.createQueue(QUEUE_RECOVERY);
  return boss;
}
