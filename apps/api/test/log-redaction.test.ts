import { describe, expect, it } from 'vitest';
import { redactRequestUrl, requestSerializer } from '../src/lib/log-redaction.js';

const TOKEN = 'rJ8kQ2mZ5vN7pX4cT1bY6wL9sA3dF0gH2jK5mN8pQ1r';

describe('bearer tokens in request logs', () => {
  it('masks every bearer-token URL shape', () => {
    expect(redactRequestUrl(`/api/invitations/${TOKEN}`)).toBe('/api/invitations/***');
    expect(redactRequestUrl(`/api/invitations/${TOKEN}/preview`)).toBe('/api/invitations/***/preview');
    expect(redactRequestUrl(`/invite/${TOKEN}`)).toBe('/invite/***');
    expect(redactRequestUrl(`/invite/${TOKEN}?from=mail`)).toBe('/invite/***?from=mail');
    expect(redactRequestUrl(`/api/shares/${TOKEN}`)).toBe('/api/shares/***');
    expect(redactRequestUrl(`/api/shares/${TOKEN}/adopt`)).toBe('/api/shares/***/adopt');
    expect(redactRequestUrl(`/share/${TOKEN}?from=mail`)).toBe('/share/***?from=mail');
    expect(redactRequestUrl(`/api/auth/verify-email?token=${TOKEN}&callbackURL=%2F&token=second#done`))
      .toBe('/api/auth/verify-email?token=***&callbackURL=%2F&token=***#done');
    expect(redactRequestUrl(`/api/auth/verify-email/?token=${TOKEN}`))
      .toBe('/api/auth/verify-email/?token=***');
    expect(redactRequestUrl(`/api/auth/reset-password/${TOKEN}?callbackURL=%2F`))
      .toBe('/api/auth/reset-password/***?callbackURL=%2F');
    expect(redactRequestUrl(`/app/api/auth/reset-password/${TOKEN}`))
      .toBe('/app/api/auth/reset-password/***');
    expect(redactRequestUrl(`/api/tasks/123?token=${TOKEN}`)).toBe('/api/tasks/123?token=***');
    expect(redactRequestUrl(`http://example.com/api/auth/verify-email?token=${TOKEN}`))
      .toBe('http://example.com/api/auth/verify-email?token=***');
  });

  it('does not rewrite unrelated routes or the accept route name', () => {
    expect(redactRequestUrl('/api/tasks/123')).toBe('/api/tasks/123');
    expect(redactRequestUrl('/api/invitations/accept')).toBe('/api/invitations/accept');
  });

  it('never emits a token through the pino request serializer', () => {
    for (const url of [
      `/invite/${TOKEN}`,
      `/api/shares/${TOKEN}`,
      `/share/${TOKEN}`,
      `/api/auth/verify-email?token=${TOKEN}&callbackURL=%2F`,
      `/api/auth/reset-password/${TOKEN}?callbackURL=%2F`,
      `http://example.com/api/auth/verify-email?token=${TOKEN}`,
    ]) {
      const line = JSON.stringify(requestSerializer({ method: 'GET', url }));
      expect(line).toContain('***');
      expect(line).not.toContain(TOKEN);
    }
  });
});
