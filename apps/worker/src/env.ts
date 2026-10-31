import { z } from 'zod';
import { DEFAULT_CODEX_HOME_ROOT } from './codex-home.js';

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
  /** Root for per-user Codex logins; each owner gets `<root>/<owner-id-hash>`. */
  CODEX_HOME_ROOT: z.string().startsWith('/', 'CODEX_HOME_ROOT must be an absolute path').default(DEFAULT_CODEX_HOME_ROOT),
  /**
   * Codex opt-in. `codex exec` can run shell commands, so the per-user CODEX_HOME alone is
   * not a security boundary. Executions stay refused unless the operator declares that an
   * isolated runner (container/VM per user) is wired around this worker.
   */
  CODEX_ISOLATED_RUNNER: z.enum(['0', '1']).default('0'),
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
