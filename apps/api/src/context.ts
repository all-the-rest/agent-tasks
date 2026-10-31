import { randomUUID } from 'node:crypto';
import type { Database } from '@agent-tasks/database';
import { auditLogs, systemSettings, userPreferences } from '@agent-tasks/database';
import { eq, sql } from 'drizzle-orm';
import { SecretBox } from '@agent-tasks/ai-providers';
import { systemSettingsSchema } from '@agent-tasks/shared';
import type { SystemSettings } from '@agent-tasks/shared';
import type { ApiEnv } from './env.js';
import type { Mailer } from './mailer.js';
import type { Auth } from './auth.js';

export interface AppContext {
  db: Database;
  env: ApiEnv;
  auth: Auth;
  mailer: Mailer;
  secrets: SecretBox;
  settings(): Promise<SystemSettings>;
  audit(entry: {
    actorId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  }): Promise<void>;
}

export function createContext(deps: { db: Database; env: ApiEnv; auth: Auth; mailer: Mailer }): AppContext {
  let cached: { value: SystemSettings; at: number } | null = null;
  return {
    ...deps,
    secrets: new SecretBox(deps.env.SECRETS_ENCRYPTION_KEY, deps.env.SECRETS_ENCRYPTION_KEY_PREVIOUS),
    async settings() {
      if (cached && Date.now() - cached.at < 5_000) return cached.value;
      const rows = await deps.db.select().from(systemSettings).where(eq(systemSettings.id, 1)).limit(1);
      const parsed = systemSettingsSchema.parse(rows[0]?.values ?? {});
      cached = { value: parsed, at: Date.now() };
      return parsed;
    },
    async audit(entry) {
      await deps.db.insert(auditLogs).values({
        id: randomUUID(),
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
      });
    },
  };
}

export async function ensurePreferences(db: Database, userId: string, timezone: string): Promise<void> {
  await db
    .insert(userPreferences)
    .values({ userId, timezone, locale: 'en', theme: 'system' })
    .onConflictDoNothing();
}

export async function saveSettings(db: Database, values: SystemSettings): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ id: 1, values })
    .onConflictDoUpdate({ target: systemSettings.id, set: { values, updatedAt: sql`now()` } });
}
