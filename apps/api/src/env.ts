import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SECRETS_ENCRYPTION_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  SETUP_TOKEN: z.string().min(16).optional(),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SEARXNG_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  /** Failed sign-ins per minute and IP before Better Auth answers 429. */
  RATE_LIMIT_SIGNIN_MAX: z.coerce.number().int().min(1).max(1000).default(5),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`invalid environment: ${details}`);
  }
  return parsed.data;
}
