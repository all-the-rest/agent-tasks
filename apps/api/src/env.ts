import { z } from 'zod';

/**
 * Docker Compose passes unset optional variables as empty strings. Treat those as
 * absent so an untouched `.env` does not fail validation.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /**
     * Directory of the built SPA. Production images set it; local development
     * leaves it unset because Vite serves the frontend on its own port.
     */
    WEB_ROOT: optional(z.string().trim().min(1)),
    DATABASE_URL: z.string().min(1),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    SECRETS_ENCRYPTION_KEY: z.string().min(1),
    SECRETS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
    /** Legacy one-time setup token; optional when ADMIN_EMAIL/ADMIN_PASSWORD are set. */
    SETUP_TOKEN: optional(z.string().min(16)),
    /** Optional first-admin bootstrap. Both must be set together. */
    ADMIN_EMAIL: optional(z.string().trim().email()),
    ADMIN_PASSWORD: optional(z.string().min(12).max(200)),
    ADMIN_NAME: optional(z.string().trim().min(1).max(100)),
    /** Seeds the database setting on first start; the admin UI can change it later. */
    ALLOW_REGISTRATION: z.enum(['true', 'false']).default('false'),
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SEARXNG_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    /** Global HTTP requests per minute and IP, including the SPA. */
    RATE_LIMIT_API_MAX: z.coerce.number().int().min(1).max(10_000).default(300),
    /** Failed sign-ins per minute and IP before Better Auth answers 429. */
    RATE_LIMIT_SIGNIN_MAX: z.coerce.number().int().min(1).max(1000).default(5),
    /** Session reads per window and IP; the E2E stack raises this for its multi-context suite. */
    RATE_LIMIT_SESSION_MAX: z.coerce.number().int().min(1).max(10_000).default(600),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.ADMIN_EMAIL) !== Boolean(value.ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.ADMIN_EMAIL ? 'ADMIN_PASSWORD' : 'ADMIN_EMAIL'],
        message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set together',
      });
    }
    if (value.NODE_ENV === 'production' && value.ALLOW_REGISTRATION === 'true' && !value.SMTP_URL?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'SMTP_URL is required when open registration is enabled in production',
      });
    }
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
