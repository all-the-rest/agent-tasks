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
      daysOfMonth: [1],
      cron: '0 9 * * 1',
    },
    endCondition: { type: 'never', date: '', runs: 1 },
    allowWebResearch: true,
    notification: 'email',
    memorySettings: { mode: 'auto', contextBytes: 12_000 },
    conversationMode: 'standalone',
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
        schedule: { preset: 'weekly', timezone: 'UTC', hour: 9, minute: 0, weekdays: [] },
      }),
    );
    expect(weekly.success).toBe(false);

    const weeklyMulti = taskFormSchema.safeParse(
      validValues({
        schedule: { preset: 'weekly', timezone: 'UTC', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      }),
    );
    expect(weeklyMulti.success).toBe(true);

    const monthly = taskFormSchema.safeParse(
      validValues({
        schedule: { preset: 'monthly', timezone: 'UTC', hour: 9, minute: 0, daysOfMonth: [] },
      }),
    );
    expect(monthly.success).toBe(false);

    const monthlyMulti = taskFormSchema.safeParse(
      validValues({
        schedule: { preset: 'monthly', timezone: 'UTC', hour: 9, minute: 0, daysOfMonth: [1, 15] },
      }),
    );
    expect(monthlyMulti.success).toBe(true);

    const custom = taskFormSchema.safeParse(
      validValues({ schedule: { preset: 'custom', timezone: 'UTC', hour: 9, minute: 0, cron: ' ' } }),
    );
    expect(custom.success).toBe(false);
  });

  it('does not expose agent execution limits in task form values or payloads', () => {
    const legacyValues = {
      ...validValues(),
      limits: { maxDurationSec: 30, maxAgentSteps: 1 },
    };
    const parsed = taskFormSchema.safeParse(legacyValues);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).not.toHaveProperty('limits');
    expect(toTaskInput(parsed.data)).not.toHaveProperty('limits');
  });

  it('validates date and run-count end conditions', () => {
    expect(taskFormSchema.safeParse(validValues({ endCondition: { type: 'on_date', date: '2026-11-03', runs: 1 } })).success).toBe(true);
    const invalidDate = taskFormSchema.safeParse(validValues({ endCondition: { type: 'on_date', date: '2026-02-30', runs: 1 } }));
    expect(invalidDate.success).toBe(false);
    if (!invalidDate.success) expect(invalidDate.error.issues.map((issue) => issue.message)).toContain('validation.endConditionInvalid');
    const invalidRunCount = taskFormSchema.safeParse(validValues({ endCondition: { type: 'after_runs', date: '', runs: 0 } }));
    expect(invalidRunCount.success).toBe(false);
    if (!invalidRunCount.success) expect(invalidRunCount.error.issues.map((issue) => issue.message)).toContain('validation.endConditionInvalid');
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

  it('sends only the selected end condition', () => {
    expect(toTaskInput(validValues({ endCondition: { type: 'after_runs', date: '', runs: 4 } })).endCondition).toEqual({
      type: 'after_runs',
      runs: 4,
    });
    expect(toTaskInput(validValues({ endCondition: { type: 'on_date', date: '2026-12-31', runs: 1 } })).endCondition).toEqual({
      type: 'on_date',
      date: '2026-12-31',
    });
  });
});
