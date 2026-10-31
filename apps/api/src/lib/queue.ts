import { PgBoss } from 'pg-boss';

export const QUEUE_EXECUTION = 'execution-run';
export const QUEUE_TICK = 'scheduler-tick';
export const QUEUE_RECOVERY = 'scheduler-recovery';

let boss: PgBoss | null = null;

export async function getBoss(connectionString: string): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({
    connectionString,
    schema: 'pgboss',
    max: 2,
    application_name: 'agent-tasks-api',
    supervise: false,
    schedule: false,
  });
  instance.on('error', (error: Error) => {
    console.error(JSON.stringify({ level: 'error', event: 'pgboss_error', message: (error as Error).message }));
  });
  await instance.start();
  await instance.createQueue(QUEUE_EXECUTION);
  boss = instance;
  return boss;
}

export async function enqueueExecution(connectionString: string, executionId: string): Promise<void> {
  const instance = await getBoss(connectionString);
  await instance.send(
    QUEUE_EXECUTION,
    { executionId },
    {
      singletonKey: executionId,
      retryLimit: 0,
      expireInSeconds: 3_600,
      priority: 1,
    },
  );
}

export async function closeBoss(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = null;
}
