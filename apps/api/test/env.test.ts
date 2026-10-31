import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

const base = {
  DATABASE_URL: 'postgres://agent@localhost/agent_tasks',
  AUTH_SECRET: 'a'.repeat(32),
  SECRETS_ENCRYPTION_KEY: 'encryption-key',
};

describe('API environment', () => {
  it('defaults registration to closed and OpenCode Go to the official base URL', () => {
    const env = loadEnv(base);
    expect(env.ALLOW_REGISTRATION).toBe('false');
    expect(env.OPENCODE_GO_BASE_URL).toBe('https://opencode.ai/inference/go/openai/v1');
    expect(env.OPENCODE_GO_NAME).toBe('OpenCode Go');
    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });

  it('treats empty compose variables as absent', () => {
    const env = loadEnv({
      ...base,
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '   ',
      SETUP_TOKEN: '',
      OPENCODE_GO_API_KEY: '',
      OPENCODE_GO_MODEL: '',
    });
    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
    expect(env.SETUP_TOKEN).toBeUndefined();
    expect(env.OPENCODE_GO_API_KEY).toBeUndefined();
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

  it('requires a model when the OpenCode Go key is set', () => {
    expect(() => loadEnv({ ...base, OPENCODE_GO_API_KEY: 'sk-opencode-test' })).toThrow(
      /OPENCODE_GO_MODEL/,
    );
    expect(() =>
      loadEnv({ ...base, OPENCODE_GO_API_KEY: 'sk-opencode-test', OPENCODE_GO_MODEL: 'model-a' }),
    ).not.toThrow();
  });
});
