import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  SECRETS_ENCRYPTION_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  RUNNER_URL: z.string().url().default('http://browser-runner:8081'),
  RUNNER_TOKEN: z.string().min(16),
  SEARXNG_URL: z.string().url().optional(),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Required isolated execution boundary; the worker fails startup if it is absent. */
  OPENCODE_PROVISIONER_URL: z.string().url(),
  OPENCODE_PROVISIONER_TOKEN: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_ID: z.string().min(1).optional(),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`invalid environment: ${details}`);
  }
  return parsed.data;
}
