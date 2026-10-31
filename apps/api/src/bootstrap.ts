import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { providerCredentials, providers, systemSettings, user, userPreferences } from '@agent-tasks/database';
import { compatibleConfigSchema, systemSettingsSchema } from '@agent-tasks/shared';
import type { AppContext } from './context.js';
import { DEFAULT_OPENCODE_GO_BASE_URL } from './env.js';

export interface BootstrapResult {
  settings: 'created' | 'exists';
  admin: 'created' | 'exists' | 'disabled';
  provider: 'created' | 'exists' | 'disabled';
}

// Two independent seed sections, serialised across API replicas.
const ADMIN_LOCK_ID = 761_211_002;
const PROVIDER_LOCK_ID = 761_211_003;

/**
 * Database-backed first-start configuration. Runs before the API listens:
 *
 * - materialises the settings row from `ALLOW_REGISTRATION` (only when absent, so
 *   admin-UI changes are never overwritten);
 * - creates the first ADMIN from `ADMIN_EMAIL`/`ADMIN_PASSWORD` when no admin
 *   exists (the legacy `SETUP_TOKEN` flow remains available when they are unset);
 * - seeds an OpenCode Go provider from `OPENCODE_GO_*` when configured.
 *
 * All sections are idempotent; the advisory locks make concurrent replicas safe.
 */
export async function ensureBootstrap(context: AppContext): Promise<BootstrapResult> {
  await waitForSchema(context);
  const settings = await ensureSettings(context);
  const admin = await ensureAdmin(context);
  const provider = await ensureOpenCodeGoProvider(context);
  return { settings, admin, provider };
}

/** The API may start before the worker has finished its migrations. */
async function waitForSchema(context: AppContext): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await context.db.execute(sql`select 1 from system_settings limit 1`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function ensureSettings(context: AppContext): Promise<'created' | 'exists'> {
  const rows = await context.db.select({ id: systemSettings.id }).from(systemSettings).where(eq(systemSettings.id, 1)).limit(1);
  if (rows[0]) return 'exists';
  const values = systemSettingsSchema.parse({
    allowRegistration: context.env.ALLOW_REGISTRATION === 'true',
  });
  await context.db.insert(systemSettings).values({ id: 1, values }).onConflictDoNothing();
  return 'created';
}

async function ensureAdmin(context: AppContext): Promise<'created' | 'exists' | 'disabled'> {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = context.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return 'disabled';

  const settings = await context.settings();
  let createdUserId: string | null = null;
  try {
    return await context.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK_ID})`);
      const rows = await tx.select({ count: sql<number>`count(*)::int` }).from(user).where(eq(user.role, 'ADMIN'));
      if (Number(rows[0]?.count ?? 0) > 0) return 'exists' as const;

      const created = await context.auth.api.signUpEmail({
        body: {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          name: context.env.ADMIN_NAME ?? 'Administrator',
        },
      });
      createdUserId = created.user.id;
      await tx.update(user).set({ role: 'ADMIN', emailVerified: true }).where(eq(user.id, created.user.id));
      await tx
        .insert(userPreferences)
        .values({ userId: created.user.id, timezone: settings.defaultTimezone })
        .onConflictDoNothing();
      return 'created' as const;
    });
  } catch (error) {
    // Better Auth writes on its own connection; compensate if the transaction fails.
    if (createdUserId) await context.db.delete(user).where(eq(user.id, createdUserId)).catch(() => undefined);
    throw error;
  }
}

async function ensureOpenCodeGoProvider(context: AppContext): Promise<'created' | 'exists' | 'disabled'> {
  const { OPENCODE_GO_API_KEY, OPENCODE_GO_MODEL, OPENCODE_GO_MODELS } = context.env;
  if (!OPENCODE_GO_API_KEY) return 'disabled';
  const modelIds = (OPENCODE_GO_MODELS ?? OPENCODE_GO_MODEL ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (modelIds.length === 0) return 'disabled';

  const name = context.env.OPENCODE_GO_NAME ?? 'OpenCode Go';
  const config = compatibleConfigSchema.parse({
    baseUrl: context.env.OPENCODE_GO_BASE_URL ?? DEFAULT_OPENCODE_GO_BASE_URL,
    models: modelIds.map((id) => ({ id, supportsTools: true })),
    stream: true,
    userAgent: 'agent-tasks/0.1.0',
    sessionHeader: 'x-opencode-session',
  });

  return await context.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROVIDER_LOCK_ID})`);
    const existing = await tx.select({ id: providers.id }).from(providers).where(eq(providers.name, name)).limit(1);
    if (existing[0]) return 'exists' as const;

    const defaults = await tx.select({ id: providers.id }).from(providers).where(eq(providers.isDefault, true)).limit(1);
    const providerId = randomUUID();
    await tx.insert(providers).values({
      id: providerId,
      name,
      kind: 'openai-compatible',
      config,
      enabled: true,
      isDefault: !defaults[0],
    });
    await tx.insert(providerCredentials).values({
      id: randomUUID(),
      providerId,
      ownerId: null,
      label: 'OPENCODE_GO_API_KEY',
      ciphertext: context.secrets.encrypt(OPENCODE_GO_API_KEY),
    });
    return 'created' as const;
  });
}
