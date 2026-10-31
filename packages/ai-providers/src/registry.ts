import { CodexProvider } from './codex.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { ProviderError } from './types.js';
import type { AiProvider, ProviderContext } from './types.js';

const providers: Record<string, AiProvider> = {
  ollama: new OllamaProvider(),
  'openai-compatible': new OpenAiCompatibleProvider(),
  openai: new OpenAiCompatibleProvider(),
  codex: new CodexProvider(),
};

export function providerKinds(): string[] {
  return Object.keys(providers);
}

export function createProvider(kind: string): AiProvider {
  const provider = providers[kind];
  if (!provider) throw new ProviderError('unsupported', `unknown provider kind ${kind}`);
  return provider;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * Resolves a decrypted credential for the calling user: a personal credential wins,
 * then an administrator-managed one. There is deliberately no fallback that would
 * let one user spend another user's key.
 */
export function resolveCredential(
  rows: Array<{ ownerId: string | null; ciphertext: string }>,
  userId: string,
  decrypt: (ciphertext: string) => string,
): { apiKey: string | undefined; shared: boolean } {
  const own = rows.find((row) => row.ownerId === userId);
  if (own) return { apiKey: decrypt(own.ciphertext), shared: false };
  const shared = rows.find((row) => row.ownerId === null);
  if (shared) return { apiKey: decrypt(shared.ciphertext), shared: true };
  return { apiKey: undefined, shared: false };
}

export function contextFor(record: ProviderRecord, apiKey: string | undefined): ProviderContext {
  return { apiKey, config: record.config };
}
