import { describe, expect, it } from 'vitest';
import { describeSchedule, nextOccurrence, scheduleSchema, toCron } from '../src/index.js';

const base = {
  timezone: 'Europe/Vienna',
  hour: 9,
  minute: 0,
  weekdays: undefined,
  dayOfMonth: undefined,
  daysOfMonth: undefined,
  runAt: undefined,
  cron: undefined,
} as const;

function schedule(overrides: Record<string, unknown>) {
  return scheduleSchema.parse({ ...base, preset: 'daily', ...overrides });
}

describe('schedule presets', () => {
  it('maps presets to cron expressions', () => {
    expect(toCron(schedule({ preset: 'daily' }))).toBe('0 9 * * *');
    expect(toCron(schedule({ preset: 'weekdays', weekdays: [1, 2, 3, 4, 5] }))).toBe('0 9 * * 1,2,3,4,5');
    expect(toCron(schedule({ preset: 'weekly', weekdays: [3] }))).toBe('0 9 * * 3');
    expect(toCron(schedule({ preset: 'weekly', weekdays: [1, 3, 5] }))).toBe('0 9 * * 1,3,5');
    expect(toCron(schedule({ preset: 'monthly', dayOfMonth: 15 }))).toBe('0 9 15 * *');
    expect(toCron(schedule({ preset: 'monthly', daysOfMonth: [1, 15, 28] }))).toBe('0 9 1,15,28 * *');
    expect(toCron(schedule({ preset: 'once', runAt: '2026-11-01T10:00:00Z' }))).toBeNull();
  });

  it('rejects invalid cron and impossible presets', () => {
    expect(scheduleSchema.safeParse({ preset: 'custom', timezone: 'Europe/Vienna', cron: 'not a cron' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ preset: 'weekly', timezone: 'Europe/Vienna' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ preset: 'weekly', timezone: 'Europe/Vienna', weekdays: [] }).success).toBe(false);
    expect(scheduleSchema.safeParse({ preset: 'weekly', timezone: 'Europe/Vienna', weekdays: [1, 3] }).success).toBe(true);
    expect(scheduleSchema.safeParse({ preset: 'monthly', timezone: 'Europe/Vienna' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ preset: 'monthly', timezone: 'Europe/Vienna', daysOfMonth: [1, 15] }).success).toBe(true);
    expect(scheduleSchema.safeParse({ preset: 'daily', timezone: 'Mars/Phobos' }).success).toBe(false);
  });

  it('computes the next occurrence in UTC for a Vienna wall clock', () => {
    const summer = nextOccurrence(schedule({ preset: 'daily' }), new Date('2026-07-01T00:00:00Z'));
    expect(summer?.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    const winter = nextOccurrence(schedule({ preset: 'daily' }), new Date('2026-12-01T00:00:00Z'));
    expect(winter?.toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('computes the next occurrence for multi-day weekly and monthly schedules', () => {
    const weekly = nextOccurrence(
      schedule({ preset: 'weekly', weekdays: [1, 4] }),
      new Date('2026-07-01T00:00:00Z'), // Wednesday
    );
    expect(weekly?.toISOString()).toBe('2026-07-02T07:00:00.000Z'); // Thursday
    const monthly = nextOccurrence(
      schedule({ preset: 'monthly', daysOfMonth: [1, 15] }),
      new Date('2026-07-02T00:00:00Z'),
    );
    expect(monthly?.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('runs a 02:30 job on the spring-forward day at 03:30 local (DST gap)', () => {
    const dst = nextOccurrence(schedule({ preset: 'daily', hour: 2, minute: 30 }), new Date('2026-03-28T12:00:00Z'));
    // Europe/Vienna skips 02:00–03:00 on 2026-03-29; the job is not dropped.
    expect(dst?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit', hour12: false }).format(dst as Date)).toBe('03:30');
  });

  it('runs an ambiguous 02:30 job once, at the first (CEST) instant on fall-back day', () => {
    const dst = nextOccurrence(schedule({ preset: 'daily', hour: 2, minute: 30 }), new Date('2026-10-24T12:00:00Z'));
    expect(dst?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    const next = nextOccurrence(schedule({ preset: 'daily', hour: 2, minute: 30 }), dst as Date);
    expect(next?.toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });

  it('returns null for a one-off run in the past', () => {
    const once = schedule({ preset: 'once', runAt: '2026-01-01T10:00:00Z' });
    expect(nextOccurrence(once, new Date('2026-02-01T00:00:00Z'))).toBeNull();
  });

  it('describes a schedule for the UI', () => {
    expect(describeSchedule(schedule({ preset: 'daily' }))).toContain('every day 09:00 Europe/Vienna');
    expect(describeSchedule(schedule({ preset: 'weekly', weekdays: [1, 3] }))).toContain('weekly on 1,3');
    expect(describeSchedule(schedule({ preset: 'monthly', daysOfMonth: [1, 15] }))).toContain('monthly on day 1,15');
  });
});
