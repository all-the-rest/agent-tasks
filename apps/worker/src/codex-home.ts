import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

/** Default root; one subdirectory per task owner below it. */
export const DEFAULT_CODEX_HOME_ROOT = '/var/lib/agent-tasks/codex';

export interface ResolvedProviderConfig {
  /** Config handed to the adapter. For Codex this carries the per-user `codexHome`. */
  config: Record<string, unknown>;
  /** Directory that must exist before the adapter runs; `null` when the provider is not Codex. */
  codexHome: string | null;
}

/**
 * A filesystem-safe, fixed-length name for an owner id.
 *
 * Better Auth ids are opaque strings (currently 32 characters), not UUIDs, so the id
 * must never be used as a path segment. Hashing encodes every id — including ids that
 * contain `/`, `\` or `..` — into a single `[0-9a-f]{64}` segment, and keeps two
 * owners distinct as long as their ids differ.
 */
export function codexHomeSegment(ownerId: string): string {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error('owner id is empty; refusing to derive a Codex home directory');
  }
  return createHash('sha256').update(ownerId, 'utf8').digest('hex');
}

/**
 * Per-user `CODEX_HOME`. The owner id only ever contributes a hash, so no separators,
 * `..`, NUL bytes or absolute paths can escape `root`. The root itself must be absolute.
 */
export function codexHomeFor(root: string, ownerId: string): string {
  if (!isAbsolute(root)) throw new Error('CODEX_HOME_ROOT must be an absolute path');
  return join(root, codexHomeSegment(ownerId));
}

/**
 * Builds the adapter config for a run. Codex gets a per-user `codexHome` that replaces
 * whatever the global provider row declared; every other kind is passed through as-is.
 * Pure, so the path rules are unit-testable without spawning `codex`.
 */
export function resolveProviderConfig(kind: string, config: Record<string, unknown>, ownerId: string, root: string = DEFAULT_CODEX_HOME_ROOT): ResolvedProviderConfig {
  if (kind !== 'codex') return { config, codexHome: null };
  const codexHome = codexHomeFor(root, ownerId);
  return { config: { ...config, codexHome }, codexHome };
}
