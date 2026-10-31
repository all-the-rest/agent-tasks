import { compatibleConfigSchema } from '../src/schemas.js';
import { describe, expect, it } from 'vitest';
import { taskInputSchema, taskUpdateSchema, userPreferencesUpdateSchema } from '../src/index.js';

const createBody = {
  title: 'Daily research',
  prompt: 'Research the current state of public transport in Vienna.',
  providerId: '00000000-0000-4000-8000-000000000001',
  model: 'mock-researcher',
  schedule: { preset: 'daily', timezone: 'Europe/Vienna' },
  limits: {},
};

describe('PATCH schemas do not apply create defaults', () => {
  it('still fills defaults for a create body', () => {
    const created = taskInputSchema.parse(createBody);
    expect(created).toMatchObject({ enabled: true, allowWebResearch: true, notification: 'none' });
    expect(created.limits.maxAgentSteps).toBeGreaterThan(0);
  });

  it('leaves omitted task fields absent on update', () => {
    const update = taskUpdateSchema.parse({ title: 'Renamed task' });
    expect(update).toEqual({ title: 'Renamed task' });
    expect('enabled' in update).toBe(false);
    expect('allowWebResearch' in update).toBe(false);
    expect('notification' in update).toBe(false);
    expect('limits' in update).toBe(false);
  });

  it('keeps an explicit update value', () => {
    const update = taskUpdateSchema.parse({ enabled: false, allowWebResearch: false });
    expect(update).toEqual({ enabled: false, allowWebResearch: false });
  });

  it('leaves omitted preference fields absent on update', () => {
    expect(userPreferencesUpdateSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(userPreferencesUpdateSchema.parse({})).toEqual({});
  });
});


describe('OpenCode Go client contract schema', () => {
  it('defaults to a tool user agent and the x-opencode-session header', () => {
    const parsed = compatibleConfigSchema.parse({ baseUrl: 'https://opencode.ai/inference/go/openai/v1' });
    expect(parsed.userAgent).toBe('agent-tasks/0.1.0');
    expect(parsed.sessionHeader).toBe('x-opencode-session');
  });

  it('rejects generic SDK user agents and an empty session header', () => {
    for (const userAgent of ['node', 'undici/6.0', 'axios', 'openai-node', 'curl/8.0', 'python-requests/2.31']) {
      expect(compatibleConfigSchema.safeParse({ baseUrl: 'https://x.test/v1', userAgent }).success, userAgent).toBe(false);
    }
    expect(compatibleConfigSchema.safeParse({ baseUrl: 'https://x.test/v1', sessionHeader: '' }).success).toBe(false);
    expect(compatibleConfigSchema.safeParse({ baseUrl: 'https://x.test/v1', userAgent: 'my-coding-agent/1.0' }).success).toBe(true);
  });
});
