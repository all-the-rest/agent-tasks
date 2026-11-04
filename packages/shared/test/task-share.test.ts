import { describe, expect, it } from 'vitest';
import { taskShareAdoptSchema, taskShareSnapshotSchema } from '../src/index.js';

const snapshot = {
  title: 'Vienna transit monitor',
  prompt: 'Research public transport changes in Vienna and cite the sources you opened.',
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  timezone: 'Europe/Vienna',
};

describe('task share snapshot', () => {
  it('accepts the closed definition-only shape', () => {
    const parsed = taskShareSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(Object.keys(parsed).sort()).toEqual(['prompt', 'schedule', 'timezone', 'title']);
  });

  it('refuses fields outside the approved snapshot', () => {
    for (const extra of [
      { systemInstructions: 'SECRET' },
      { description: 'SECRET' },
      { providerId: '00000000-0000-4000-8000-000000000000' },
      { model: 'secret-model' },
      { memory: ['SECRET'] },
      { history: [] },
      { ownerId: 'user-1' },
    ]) {
      expect(taskShareSnapshotSchema.safeParse({ ...snapshot, ...extra }).success).toBe(false);
    }
  });

  it('requires a timezone that matches the schedule', () => {
    expect(
      taskShareSnapshotSchema.safeParse({ ...snapshot, timezone: 'Europe/Berlin' }).success,
    ).toBe(false);
  });

  it('refuses to adopt with smuggled fields or without a provider/model', () => {
    const valid = { providerId: '00000000-0000-4000-8000-000000000000', model: 'local-model' };
    expect(taskShareAdoptSchema.safeParse(valid).success).toBe(true);
    expect(taskShareAdoptSchema.safeParse({ ...valid, prompt: 'injected' }).success).toBe(false);
    expect(taskShareAdoptSchema.safeParse({ ...valid, ownerId: 'other-user' }).success).toBe(false);
    expect(taskShareAdoptSchema.safeParse({ model: 'local-model' }).success).toBe(false);
    expect(taskShareAdoptSchema.safeParse({ ...valid, model: '   ' }).success).toBe(false);
  });
});
