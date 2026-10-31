import { z } from 'zod';
import { limitsSchema } from './limits.js';
import { scheduleSchema } from './schedule.js';
import { EXECUTION_STATUSES, REPORT_CONFIDENCE, ROLES } from './status.js';

export const idSchema = z.string().uuid();
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'lowercase letters, digits, dash and underscore only');

export const providerKindSchema = z.enum(['ollama', 'openai-compatible', 'openai', 'codex']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** A model the endpoint serves when it has no usable `/models` route. */
export const providerModelConfigSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(200).optional(),
  supportsTools: z.boolean().default(false),
  contextLength: z.number().int().min(1).optional(),
});
export type ProviderModelConfig = z.infer<typeof providerModelConfigSchema>;

/** Network + header settings shared by every OpenAI-compatible endpoint. */
export const compatibleConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  /** Extra headers sent with every request, e.g. OpenCode Go's `x-opencode-session`. */
  headers: z.record(z.string().min(1).max(64), z.string().max(600)).default({}),
  /** Sent as User-Agent. OpenCode Go requires an honest client identifier. */
  userAgent: z.string().min(1).max(120).default('agent-tasks/0.1.0'),
  /** Header that carries a stable per-conversation session id (`x-opencode-session` for Go). */
  sessionHeader: z.string().max(64).default('x-opencode-session'),
  organization: z.string().max(120).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  /** Ask for server-sent events; the adapter defaults to streaming. */
  stream: z.boolean().default(true),
  /** Declared models, used when the endpoint cannot be probed or `supportsTools` must be pinned. */
  models: z.array(providerModelConfigSchema).max(200).default([]),
});
export type CompatibleConfig = z.infer<typeof compatibleConfigSchema>;

export const ollamaConfigSchema = z.object({
  baseUrl: z.string().url().max(500).default('http://ollama:11434'),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
  /** Models without tool-calling support are refused rather than silently degraded. */
  requireToolSupport: z.boolean().default(true),
});

/**
 * Configuration the Codex adapter actually reads (`packages/ai-providers/src/codex.ts`).
 * None of these fields is a secret: the login state lives in `codexHome`, which the
 * operator provisions out of band. NOTE: this is a single, deployment-global directory;
 * requirement 07's per-user `CODEX_HOME` mapping is still not implemented.
 */
export const codexConfigSchema = z.object({
  /** The adapter also requires AGENT_TASKS_ENABLE_CODEX=1; this flag is the record-level opt-in. */
  enabled: z.boolean().default(false),
  codexHome: z.string().min(1).max(1_000).startsWith('/'),
  binary: z.string().min(1).max(300).default('codex'),
  /** The CLI has no model discovery, so models are declared here. */
  models: z.array(providerModelConfigSchema).max(200).default([]),
});
export type CodexConfig = z.infer<typeof codexConfigSchema>;

/**
 * Zod 4 keeps a field's `.default()` active even after `.partial()` wraps it in
 * optional: parsing `{}` still materialises every default. That is correct for a
 * create body but wrong for a PATCH body, where an omitted key means "leave the
 * stored value alone". Removing the defaults before `.partial()` keeps them absent.
 */
function withoutDefaults<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.removeDefault() : field,
    ]),
  ) as T['shape'];
  return z.object(shape) as unknown as T;
}

export const taskInputSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().max(2_000).optional(),
  prompt: z.string().min(10).max(20_000),
  systemInstructions: z.string().max(8_000).optional(),
  providerId: idSchema,
  model: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  schedule: scheduleSchema,
  limits: limitsSchema,
  allowWebResearch: z.boolean().default(true),
  notification: z.enum(['none', 'email']).default('none'),
});

export const taskUpdateSchema = withoutDefaults(taskInputSchema).partial();

export const executionReportSchema = z.object({
  summary: z.string().max(2_000),
  markdown: z.string().max(400_000),
  sources: z
    .array(
      z.object({
        url: z.string().max(2_000),
        title: z.string().max(300).optional(),
        retrievedAt: z.string(),
        confidence: z.enum(REPORT_CONFIDENCE).default('unknown'),
        excerpt: z.string().max(1_000).optional(),
      }),
    )
    .max(50),
  uncertainty: z.array(z.string().max(500)).max(20).default([]),
});
export type ExecutionReport = z.infer<typeof executionReportSchema>;

export const toolCallSchema = z.object({
  step: z.number().int().min(1),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  ok: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  error: z.string().max(1_000).optional(),
  resultPreview: z.string().max(1_000).optional(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const executionSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  ownerId: z.string(),
  status: z.enum(EXECUTION_STATUSES),
  trigger: z.enum(['schedule', 'manual', 'retry']),
  providerId: idSchema.nullable(),
  model: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  report: executionReportSchema.nullable(),
  toolCalls: z.array(toolCallSchema).default([]),
  usage: z
    .object({
      promptTokens: z.number().int().optional(),
      completionTokens: z.number().int().optional(),
      totalTokens: z.number().int().optional(),
      allowanceUsd: z.number().optional(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type Execution = z.infer<typeof executionSchema>;

export const roleSchema = z.enum(ROLES);

export const inviteSchema = z.object({
  email: z.string().email(),
  role: roleSchema.default('USER'),
});

export const userPreferencesSchema = z.object({
  timezone: z.string().max(64).default('Europe/Vienna'),
  locale: z.enum(['en', 'de']).default('en'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

/** Partial preferences PATCH: omitted theme/locale must not reset the stored values. */
export const userPreferencesUpdateSchema = withoutDefaults(userPreferencesSchema).partial();

export const systemSettingsSchema = z.object({
  allowRegistration: z.boolean().default(false),
  defaultTimezone: z.string().max(64).default('Europe/Vienna'),
  defaultModel: z.string().max(120).optional(),
  maxConcurrentExecutionsPerUser: z.number().int().min(1).max(10).default(2),
  maxTaskExecutionsPerDay: z.number().int().min(1).max(500).default(50),
  browserAllowHttp: z.boolean().default(true),
  browserAllowedPorts: z.array(z.number().int().min(1).max(65535)).default([80, 443]),
  searchProvider: z.enum(['searxng', 'none']).default('searxng'),
  searchBaseUrl: z.string().url().default('http://searxng:8080'),
  smtpFrom: z.string().email().optional(),
  publicBaseUrl: z.string().url().optional(),
});
export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(2).max(120),
  password: z.string().min(12).max(200),
});

export const idempotencyKeySchema = z.string().uuid();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().datetime().optional(),
});
