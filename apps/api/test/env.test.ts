import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

const base = {
  DATABASE_URL: 'postgres://agent@localhost/agent_tasks',
  AUTH_SECRET: 'a'.repeat(32),
  SECRETS_ENCRYPTION_KEY: 'encryption-key',
};

describe('API environment', () => {
  it('defaults registration to closed', () => {
    const env = loadEnv(base);
    expect(env.ALLOW_REGISTRATION).toBe('false');
    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });

  it('treats empty compose variables as absent', () => {
    const env = loadEnv({
      ...base,
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '   ',
      SETUP_TOKEN: '',
    });
    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
    expect(env.SETUP_TOKEN).toBeUndefined();
  });

  it('requires ADMIN_EMAIL and ADMIN_PASSWORD together', () => {
    expect(() => loadEnv({ ...base, ADMIN_EMAIL: 'admin@example.com' })).toThrow(/ADMIN_PASSWORD/);
    expect(() => loadEnv({ ...base, ADMIN_PASSWORD: 'admin-password-123' })).toThrow(/ADMIN_EMAIL/);
  });

  it('rejects a too-short admin password', () => {
    expect(() =>
      loadEnv({ ...base, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'short' }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it('ignores provider seed variables (the admin UI is the only source)', () => {
    const env = loadEnv({
      ...base,
      OPENCODE_GO_API_KEY: 'sk-opencode-test',
      OPENCODE_GO_MODEL: 'model-a',
    });
    expect(env).not.toHaveProperty('OPENCODE_GO_API_KEY');
  });
});
