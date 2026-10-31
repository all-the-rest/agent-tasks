import { describe, expect, it } from 'vitest';
import { redactRequestUrl, requestSerializer } from '../src/lib/log-redaction.js';

const TOKEN = 'rJ8kQ2mZ5vN7pX4cT1bY6wL9sA3dF0gH2jK5mN8pQ1r';

describe('invitation tokens in request logs', () => {
  it('masks both invitation URL shapes', () => {
    expect(redactRequestUrl(`/api/invitations/${TOKEN}`)).toBe('/api/invitations/***');
    expect(redactRequestUrl(`/api/invitations/${TOKEN}/preview`)).toBe('/api/invitations/***/preview');
    expect(redactRequestUrl(`/invite/${TOKEN}`)).toBe('/invite/***');
    expect(redactRequestUrl(`/invite/${TOKEN}?from=mail`)).toBe('/invite/***?from=mail');
  });

  it('does not rewrite unrelated routes or the accept route name', () => {
    expect(redactRequestUrl('/api/tasks/123')).toBe('/api/tasks/123');
    expect(redactRequestUrl('/api/invitations/accept')).toBe('/api/invitations/accept');
  });

  it('never emits the token through the pino request serializer', () => {
    const line = JSON.stringify(requestSerializer({ method: 'GET', url: `/invite/${TOKEN}` }));
    expect(line).toContain('***');
    expect(line).not.toContain(TOKEN);
  });
});
