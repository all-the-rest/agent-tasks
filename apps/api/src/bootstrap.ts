import { eq, sql } from 'drizzle-orm';
import { systemSettings, user, userPreferences } from '@agent-tasks/database';
import { systemSettingsSchema } from '@agent-tasks/shared';
import type { AppContext } from './context.js';
import { withTrustedSignup } from './auth.js';

export interface BootstrapResult {
  settings: 'created' | 'exists';
  admin: 'created' | 'exists' | 'disabled';
}

// Seed section serialised across API replicas.
const ADMIN_LOCK_ID = 761_211_002;

/**
 * Database-backed first-start configuration. Runs before the API listens:
 *
 * - materialises the settings row from `ALLOW_REGISTRATION` (only when absent, so
 *   admin-UI changes are never overwritten);
 * - creates the first ADMIN from `ADMIN_EMAIL`/`ADMIN_PASSWORD` when no admin
 *   exists (the legacy `SETUP_TOKEN` flow remains available when they are unset).
 *
 * Provider connections are deliberately not seeded from the environment: the
 * admin UI/API is the only write path, so credentials never live in deployment
 * configuration and every change is auditable. All sections are idempotent; the
 * advisory lock makes concurrent replicas safe.
 */
export async function ensureBootstrap(context: AppContext): Promise<BootstrapResult> {
  await waitForSchema(context);
  const settings = await ensureSettings(context);
  const admin = await ensureAdmin(context);
  return { settings, admin };
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

      const created = await withTrustedSignup(() => context.auth.api.signUpEmail({
        body: {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          name: context.env.ADMIN_NAME ?? 'Administrator',
        },
      }));
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
