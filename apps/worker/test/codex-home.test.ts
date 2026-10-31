import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexHomeFor, resolveProviderConfig } from '../src/codex-home.js';

const ROOT = '/var/lib/agent-tasks/codex';
/** Better Auth ids are opaque 32-character strings, not UUIDs. */
const OWNER_A = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const OWNER_B = '0123456789abcdefghijklmnopqrstuv';

const segment = (ownerId: string): string => createHash('sha256').update(ownerId, 'utf8').digest('hex');

describe('per-user Codex home', () => {
  it('derives a stable directory from a Better-Auth-shaped 32-character id', () => {
    expect(OWNER_A).toHaveLength(32);
    expect(codexHomeFor(ROOT, OWNER_A)).toBe(join(ROOT, segment(OWNER_A)));
    expect(codexHomeFor(ROOT, OWNER_A)).toBe(codexHomeFor(ROOT, OWNER_A));
  });

  it('gives two owners different directories', () => {
    const homeA = codexHomeFor(ROOT, OWNER_A);
    const homeB = codexHomeFor(ROOT, OWNER_B);
    expect(homeA).not.toBe(homeB);
    expect(basename(homeA)).toMatch(/^[0-9a-f]{64}$/);
    expect(basename(homeB)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodes traversal-shaped ids into a single safe segment instead of escaping the root', () => {
    for (const bad of ['../escape', '..', '.', 'a/../b', '/abs/path', '..\\escape', 'owner\0suffix', 'x'.repeat(256)]) {
      const home = codexHomeFor(ROOT, bad);
      expect(dirname(home), bad).toBe(ROOT);
      expect(basename(home), bad).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses an empty owner id', () => {
    expect(() => codexHomeFor(ROOT, '')).toThrow(/empty/);
  });

  it('refuses a relative CODEX_HOME_ROOT', () => {
    expect(() => codexHomeFor('relative/codex', OWNER_A)).toThrow(/absolute/);
  });

  it('builds a per-user Codex config without mutating the stored row', () => {
    const stored = { enabled: true, codexHome: '/shared/global-codex', models: [{ id: 'gpt-5-codex' }] };
    const resolved = resolveProviderConfig('codex', stored, OWNER_A, ROOT);
    expect(resolved.codexHome).toBe(join(ROOT, segment(OWNER_A)));
    expect(resolved.config).toEqual({ ...stored, codexHome: join(ROOT, segment(OWNER_A)) });
    expect(stored.codexHome).toBe('/shared/global-codex');
  });

  it('leaves other provider kinds and their owner ids untouched', () => {
    const stored = { baseUrl: 'http://ollama:11434' };
    const resolved = resolveProviderConfig('ollama', stored, 'not-a-uuid', ROOT);
    expect(resolved).toEqual({ config: stored, codexHome: null });
    expect(resolved.config).toBe(stored);
  });
});
