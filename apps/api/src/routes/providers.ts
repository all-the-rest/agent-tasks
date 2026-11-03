import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { providerCredentials, providerModels, providers } from '@agent-tasks/database';
import { AppError, classifyAddress, codexConfigSchema, compatibleConfigSchema, normalizeHostname, ollamaConfigSchema, providerKindSchema } from '@agent-tasks/shared';
import { createProvider, contextFor, resolveCredential } from '@agent-tasks/ai-providers';
import type { AppContext } from '../context.js';
import { AUDIT_ACTIONS } from '../lib/audit.js';
import { requireAdmin, requireUser, requireUuid } from '../lib/session.js';

/** Config keys an administrator may see. Credentials are never part of this list. */
const SAFE_CONFIG_KEYS = [
  'baseUrl',
  'models',
  'userAgent',
  'sessionHeader',
  'organization',
  'timeoutMs',
  'stream',
  'requireToolSupport',
  'enabled',
  'codexHome',
  'binary',
  'defaultModel',
  'disabledModels',
] as const;

const REDACTED_HEADER_VALUE = '***';

/**
 * `config.headers` is the documented place for bearer tokens, so an admin response must
 * never echo it verbatim. Keep the header names (so the shape stays debuggable) and
 * replace every value; drop any key that is not explicitly known to be non-secret.
 */
export function redactProviderConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const key of SAFE_CONFIG_KEYS) {
    if (key in source) redacted[key] = source[key];
  }
  const headers = source.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    redacted.headers = Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED_HEADER_VALUE]));
  }
  return redacted;
}

/**
 * The admin view replaces every header value with `***`. When that view is edited and
 * sent back, `***` means "unchanged", not "store three asterisks as the bearer token".
 * Restore the stored value for those header names before validation.
 */
export function restoreRedactedHeaders(incoming: unknown, stored: unknown): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const incomingConfig = { ...(incoming as Record<string, unknown>) };
  const incomingHeaders = incomingConfig.headers;
  if (!incomingHeaders || typeof incomingHeaders !== 'object' || Array.isArray(incomingHeaders)) return incoming;
  const storedHeaders =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).headers
      : undefined;
  if (!storedHeaders || typeof storedHeaders !== 'object' || Array.isArray(storedHeaders)) return incoming;

  incomingConfig.headers = Object.fromEntries(
    Object.entries(incomingHeaders as Record<string, unknown>).map(([name, value]) => {
      const previous = (storedHeaders as Record<string, unknown>)[name];
      return [name, value === REDACTED_HEADER_VALUE && typeof previous === 'string' ? previous : value];
    }),
  );
  return incomingConfig;
}

/** Each provider kind has its own contract; the Codex adapter does not read `baseUrl`. */
function parseProviderConfig(kind: string, value: unknown): unknown {
  const schema = kind === 'ollama' ? ollamaConfigSchema : kind === 'codex' ? codexConfigSchema : compatibleConfigSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw AppError.badRequest('invalid provider config', parsed.error.issues);
  if (kind !== 'codex') assertProviderBaseUrl((parsed.data as { baseUrl: string }).baseUrl);
  return parsed.data;
}

/**
 * Provider endpoints are admin-controlled, but a mistaken or copied value must not
 * turn the server into an SSRF gadget. Loopback, link-local and cloud-metadata
 * addresses are always refused. Public hosts must use https; plain http stays
 * available for internal single-label service names (`ollama`, `mock`) and private
 * addresses, whose traffic never leaves the deployment network.
 */
export function assertProviderBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest('provider base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw AppError.badRequest('provider base URL must use http or https');
  if (url.username || url.password) throw AppError.badRequest('provider base URL must not contain credentials');
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw AppError.badRequest('provider base URL has an invalid host');
  if (isIP(hostname)) {
    const addressClass = classifyAddress(hostname);
    if (['loopback', 'link_local', 'metadata', 'unspecified', 'multicast', 'reserved'].includes(addressClass)) {
      throw AppError.badRequest(`provider base URL address is not allowed (${addressClass})`);
    }
    if (url.protocol === 'http:' && addressClass !== 'private' && addressClass !== 'unique_local') {
      throw AppError.badRequest('provider base URL must use https for a public address');
    }
    return;
  }
  const internalName = !hostname.includes('.') || hostname.endsWith('.internal') || hostname.endsWith('.local');
  if (url.protocol === 'http:' && !internalName) {
    throw AppError.badRequest('provider base URL must use https for a public host');
  }
}

function adminProviderView<T extends { config: unknown }>(provider: T): T & { config: Record<string, unknown> } {
  return { ...provider, config: redactProviderConfig(provider.config) };
}

export async function registerProviderRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, secrets } = context;

  app.get('/api/providers', async (request) => {
    const me = await requireUser(context, request);
    const rows = await db
      .select({ id: providers.id, name: providers.name, kind: providers.kind, isDefault: providers.isDefault, config: providers.config })
      .from(providers)
      .where(eq(providers.enabled, true))
      .orderBy(desc(providers.isDefault), providers.name);
    const credentials = await db
      .select({ providerId: providerCredentials.providerId, ownerId: providerCredentials.ownerId })
      .from(providerCredentials)
      .where(or(isNull(providerCredentials.ownerId), eq(providerCredentials.ownerId, me.id)));
    const models = await db.select().from(providerModels);
    return rows.map((provider) => {
      const config = provider.config as Record<string, unknown>;
      const disabledModels = Array.isArray(config.disabledModels) ? config.disabledModels.filter((id): id is string => typeof id === 'string') : [];
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        isDefault: provider.isDefault,
        // Only non-secret, browser-safe configuration leaves the server.
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : undefined,
        // Preselected catalog model for new tasks (admin choice, not a secret).
        defaultModel: typeof config.defaultModel === 'string' ? config.defaultModel : undefined,
        hasCredential: credentials.some((credential) => credential.providerId === provider.id && (credential.ownerId === null || credential.ownerId === me.id)),
        hasPersonalCredential: credentials.some((credential) => credential.providerId === provider.id && credential.ownerId === me.id),
        models: models
          .filter((model) => model.providerId === provider.id && !disabledModels.includes(model.modelId))
          .map((model) => ({ id: model.modelId, label: model.label, supportsTools: model.supportsTools, contextLength: model.contextLength })),
      };
    });
  });

  app.post<{ Params: { id: string }; Body: { apiKey?: string; label?: string } }>('/api/providers/:id/credentials', async (request, reply) => {
    const me = await requireUser(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey || apiKey.length < 8) throw AppError.badRequest('apiKey is required');
    const providerRows = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (!providerRows[0]) throw AppError.notFound('provider');
    const label = request.body?.label ?? 'default';
    const [created] = await db
      .insert(providerCredentials)
      .values({
        id: randomUUID(),
        providerId,
        ownerId: me.id,
        label,
        ciphertext: secrets.encrypt(apiKey),
      })
      .onConflictDoUpdate({
        target: [providerCredentials.providerId, providerCredentials.ownerId, providerCredentials.label],
        set: { ciphertext: secrets.encrypt(apiKey) },
      })
      .returning({ id: providerCredentials.id });
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.credentialCreated, targetType: 'provider', targetId: providerId, metadata: { scope: 'personal' } });
    reply.code(201);
    return { id: created?.id };
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id/credentials', async (request, reply) => {
    const me = await requireUser(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const providerRows = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (!providerRows[0]) throw AppError.notFound('provider');
    await db
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.ownerId, me.id)));
    await context.audit({ actorId: me.id, action: AUDIT_ACTIONS.credentialDeleted, targetType: 'provider', targetId: providerId, metadata: { scope: 'personal' } });
    reply.code(204);
    return null;
  });

  /* ----------------------------- admin only ----------------------------- */

  app.get('/api/admin/providers', async (request) => {
    await requireAdmin(context, request);
    const rows = await db.select().from(providers).orderBy(providers.name);
    const credentials = await db.select({ providerId: providerCredentials.providerId, ownerId: providerCredentials.ownerId }).from(providerCredentials);
    const models = await db.select().from(providerModels);
    return rows.map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled,
      isDefault: provider.isDefault,
      config: redactProviderConfig(provider.config),
      sharedCredential: credentials.some((credential) => credential.providerId === provider.id && credential.ownerId === null),
      personalCredentials: credentials.filter((credential) => credential.providerId === provider.id && credential.ownerId !== null).length,
      // The catalog is admin-visible so one connection can be approved and the
      // task editor only offers models that actually exist.
      models: models
        .filter((model) => model.providerId === provider.id)
        .map((model) => ({ id: model.modelId, label: model.label, supportsTools: model.supportsTools, contextLength: model.contextLength })),
    }));
  });

  app.post<{ Body: { name?: string; kind?: string; config?: unknown; enabled?: boolean; isDefault?: boolean } }>('/api/admin/providers', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const kind = providerKindSchema.safeParse(request.body?.kind);
    if (!kind.success) throw AppError.badRequest('unknown provider kind');
    const name = request.body?.name?.trim();
    if (!name) throw AppError.badRequest('name is required');
    const config = parseProviderConfig(kind.data, request.body?.config ?? {});
    const id = randomUUID();
    const [created] = await db
      .insert(providers)
      .values({ id, name, kind: kind.data, config, enabled: request.body?.enabled ?? true, isDefault: request.body?.isDefault ?? false })
      .returning();
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.providerCreated, targetType: 'provider', targetId: id, metadata: { kind: kind.data, name } });
    reply.code(201);
    return created ? adminProviderView(created) : created;
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; enabled?: boolean; isDefault?: boolean; config?: unknown } }>('/api/admin/providers/:id', async (request) => {
    const admin = await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const rows = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
    const provider = rows[0];
    if (!provider) throw AppError.notFound('provider');
    const config = request.body?.config
      ? parseProviderConfig(provider.kind, restoreRedactedHeaders(request.body.config, provider.config))
      : undefined;
    const [updated] = await db
      .update(providers)
      .set({
        ...(request.body?.name ? { name: request.body.name } : {}),
        ...(request.body?.enabled !== undefined ? { enabled: request.body.enabled } : {}),
        ...(request.body?.isDefault !== undefined ? { isDefault: request.body.isDefault } : {}),
        ...(config ? { config } : {}),
        updatedAt: new Date(),
      })
      .where(eq(providers.id, provider.id))
      .returning();
    await context.audit({
      actorId: admin.id,
      action: AUDIT_ACTIONS.providerUpdated,
      targetType: 'provider',
      targetId: provider.id,
      // Record which fields changed, never their values: the config may carry
      // headers, and an audit row is readable by every admin.
      metadata: {
        fields: [
          ...(request.body?.name ? ['name'] : []),
          ...(request.body?.enabled !== undefined ? ['enabled'] : []),
          ...(request.body?.isDefault !== undefined ? ['isDefault'] : []),
          ...(config ? ['config'] : []),
        ],
      },
    });
    return updated ? adminProviderView(updated) : updated;
  });

  app.delete<{ Params: { id: string } }>('/api/admin/providers/:id', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const deleted = await db.delete(providers).where(eq(providers.id, providerId)).returning({ id: providers.id });
    if (deleted.length === 0) throw AppError.notFound('provider');
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.providerDeleted, targetType: 'provider', targetId: providerId });
    reply.code(204);
    return null;
  });

  app.post<{ Params: { id: string }; Body: { apiKey?: string; label?: string } }>('/api/admin/providers/:id/credentials', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey || apiKey.length < 8) throw AppError.badRequest('apiKey is required');
    const label = request.body?.label ?? 'default';
    const ciphertext = secrets.encrypt(apiKey);
    /*
     * The unique index `provider_credentials_scope_unique` is a plain btree index, so
     * `ON CONFLICT (provider_id, owner_id, label)` never fires for shared rows because
     * Postgres treats NULL owner ids as distinct. Locking the provider row serialises
     * concurrent writers, then read-then-update keeps exactly one shared row per label.
     */
    await db.transaction(async (tx) => {
      const locked = await tx.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId)).limit(1).for('update');
      if (!locked[0]) throw AppError.notFound('provider');
      const existing = await tx
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(and(eq(providerCredentials.providerId, providerId), isNull(providerCredentials.ownerId), eq(providerCredentials.label, label)))
        .limit(1);
      if (existing[0]) {
        await tx.update(providerCredentials).set({ ciphertext, updatedAt: new Date() }).where(eq(providerCredentials.id, existing[0].id));
      } else {
        await tx.insert(providerCredentials).values({ id: randomUUID(), providerId, ownerId: null, label, ciphertext });
      }
    });
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.credentialCreated, targetType: 'provider', targetId: providerId, metadata: { scope: 'shared' } });
    reply.code(201);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/providers/:id/credentials', async (request, reply) => {
    const admin = await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const providerRows = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (!providerRows[0]) throw AppError.notFound('provider');
    await db.delete(providerCredentials).where(and(eq(providerCredentials.providerId, providerId), isNull(providerCredentials.ownerId)));
    await context.audit({ actorId: admin.id, action: AUDIT_ACTIONS.credentialDeleted, targetType: 'provider', targetId: providerId, metadata: { scope: 'shared' } });
    reply.code(204);
    return null;
  });

  app.post<{ Params: { id: string } }>('/api/admin/providers/:id/models/refresh', async (request) => {
    const admin = await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const rows = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
    const provider = rows[0];
    if (!provider) throw AppError.notFound('provider');
    const credentials = await db.select().from(providerCredentials).where(eq(providerCredentials.providerId, provider.id));
    const { apiKey } = resolveCredential(credentials, admin.id, (value) => secrets.decrypt(value));
    const adapter = createProvider(provider.kind);
    const models = await adapter.listModels(contextFor({ ...provider, config: provider.config as Record<string, unknown> }, apiKey));
    await db.delete(providerModels).where(eq(providerModels.providerId, provider.id));
    if (models.length > 0) {
      await db.insert(providerModels).values(
        models.map((model) => ({
          providerId: provider.id,
          modelId: model.id,
          label: model.label,
          supportsTools: model.supportsTools,
          contextLength: model.contextLength ?? null,
        })),
      );
    }
    return { models };
  });

  app.post<{ Params: { id: string } }>('/api/admin/providers/:id/health', async (request) => {
    await requireAdmin(context, request);
    const providerId = requireUuid(request.params.id, 'provider');
    const rows = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
    const provider = rows[0];
    if (!provider) throw AppError.notFound('provider');
    const credentials = await db.select().from(providerCredentials).where(eq(providerCredentials.providerId, provider.id));
    const { apiKey } = resolveCredential(credentials, 'system', (value) => secrets.decrypt(value));
    const adapter = createProvider(provider.kind);
    return adapter.health(contextFor({ ...provider, config: provider.config as Record<string, unknown> }, apiKey));
  });
}
