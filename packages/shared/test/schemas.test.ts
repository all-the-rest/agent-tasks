import { compatibleConfigSchema } from '../src/schemas.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  HARD_LIMITS,
  systemSettingsSchema,
  taskInputSchema,
  taskUpdateSchema,
  userPreferencesUpdateSchema,
} from '../src/index.js';

const createBody = {
  title: 'Daily research',
  prompt: 'Research the current state of public transport in Vienna.',
  providerId: '00000000-0000-4000-8000-000000000001',
  model: 'mock-researcher',
  schedule: { preset: 'daily', timezone: 'Europe/Vienna' },
};

describe('PATCH schemas do not apply create defaults', () => {
  it('still fills defaults for a create body', () => {
    const created = taskInputSchema.parse(createBody);
    expect(created).toMatchObject({ enabled: true, allowWebResearch: true, notification: 'none' });
    expect(created).not.toHaveProperty('limits');
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

  it('ignores legacy task-level limit input', () => {
    const created = taskInputSchema.parse({ ...createBody, limits: { maxAgentSteps: 1 } });
    const update = taskUpdateSchema.parse({ limits: { maxAgentSteps: 1 } });
    expect(created).not.toHaveProperty('limits');
    expect(update).toEqual({});
  });

  it('defaults global agent limits to the finite hard caps and lets admins lower them', () => {
    expect(DEFAULT_LIMITS).toEqual(HARD_LIMITS);
    expect(systemSettingsSchema.parse({}).agentLimits).toEqual(HARD_LIMITS);
    expect(systemSettingsSchema.parse({ agentLimits: { maxDurationSec: 600 } }).agentLimits)
      .toMatchObject({ ...HARD_LIMITS, maxDurationSec: 600 });
    expect(systemSettingsSchema.safeParse({ agentLimits: { maxDurationSec: HARD_LIMITS.maxDurationSec + 1 } }).success)
      .toBe(false);
  });

  it('leaves omitted preference fields absent on update', () => {
    expect(userPreferencesUpdateSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(userPreferencesUpdateSchema.parse({})).toEqual({});
  });
});


describe('schedule time-of-day presets', () => {
  it('defaults the friendly preset times', () => {
    expect(systemSettingsSchema.parse({}).scheduleTimePresets).toEqual({
      morning: '09:00',
      afternoon: '14:00',
      evening: '18:00',
      night: '22:00',
    });
  });

  it('accepts configured times and rejects malformed clocks', () => {
    const configured = systemSettingsSchema.parse({
      scheduleTimePresets: { morning: '07:30', afternoon: '12:00', evening: '19:15', night: '23:00' },
    });
    expect(configured.scheduleTimePresets).toEqual({
      morning: '07:30',
      afternoon: '12:00',
      evening: '19:15',
      night: '23:00',
    });
    expect(systemSettingsSchema.safeParse({ scheduleTimePresets: { morning: '7:30' } }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ scheduleTimePresets: { night: '24:00' } }).success).toBe(false);
  });
});

describe('OpenCode Go client contract schema', () => {  it('defaults to a tool user agent and the x-opencode-session header', () => {
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
