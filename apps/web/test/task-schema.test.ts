import { describe, expect, it } from 'vitest';
import { taskFormSchema, toTaskInput } from '../src/lib/task-schema';
import type { TaskFormValues } from '../src/lib/task-schema';

const providerId = '11111111-1111-4111-8111-111111111111';

function validValues(overrides: Partial<TaskFormValues> = {}): TaskFormValues {
  return {
    title: 'Weekly competitor briefing',
    description: 'Summarise pricing changes.',
    prompt: 'Research the public pricing pages of our five closest competitors.',
    systemInstructions: '',
    providerId,
    model: 'gpt-test',
    enabled: true,
    schedule: {
      preset: 'weekly',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      weekdays: [1],
      dayOfMonth: 1,
      cron: '0 9 * * 1',
    },
    limits: {
      maxDurationSec: 300,
      maxAgentSteps: 12,
      maxPageVisits: 8,
      maxOutputBytes: 200_000,
      maxToolCalls: 24,
      maxSearchQueries: 4,
    },
    allowWebResearch: true,
    notification: 'email',
    memorySettings: { mode: 'auto', contextBytes: 12_000 },
    ...overrides,
  };
}

describe('taskFormSchema', () => {
  it('accepts a complete task', () => {
    const parsed = taskFormSchema.safeParse(validValues());
    expect(parsed.success).toBe(true);
  });

  it('rejects short titles, short prompts and invalid provider ids', () => {
    const parsed = taskFormSchema.safeParse(
      validValues({ title: 'ab', prompt: 'too short', providerId: 'not-a-uuid' }),
    );
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages).toContain('validation.titleMin');
    expect(messages).toContain('validation.promptMin');
    expect(messages).toContain('validation.providerRequired');
  });

  it('enforces the schedule preset rules', () => {
    const once = taskFormSchema.safeParse(
      validValues({ schedule: { preset: 'once', timezone: 'UTC', hour: 9, minute: 0 } }),
    );
    expect(once.success).toBe(false);

    const weekly = taskFormSchema.safeParse(
      validValues({
        schedule: { preset: 'weekly', timezone: 'UTC', hour: 9, minute: 0, weekdays: [1, 2] },
      }),
    );
    expect(weekly.success).toBe(false);

    const custom = taskFormSchema.safeParse(
      validValues({ schedule: { preset: 'custom', timezone: 'UTC', hour: 9, minute: 0, cron: ' ' } }),
    );
    expect(custom.success).toBe(false);
  });

  it('rejects limits outside the hard bounds', () => {
    const parsed = taskFormSchema.safeParse(
      validValues({
        limits: {
          maxDurationSec: 10,
          maxAgentSteps: 12,
          maxPageVisits: 8,
          maxOutputBytes: 200_000,
          maxToolCalls: 24,
          maxSearchQueries: 4,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('toTaskInput', () => {
  it('trims strings and drops empty optional fields', () => {
    const input = toTaskInput(
      validValues({
        title: '  Briefing  ',
        description: '   ',
        systemInstructions: '',
        prompt: '  Research this carefully.  ',
      }),
    );
    expect(input.title).toBe('Briefing');
    expect(input.prompt).toBe('Research this carefully.');
    expect(input.description).toBeUndefined();
    expect(input.systemInstructions).toBeUndefined();
    expect(input.schedule.weekdays).toEqual([1]);
    expect(input.schedule.cron).toBeUndefined();
  });
});
