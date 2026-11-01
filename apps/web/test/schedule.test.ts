import { describe, expect, it } from 'vitest';
import {
  defaultSchedule,
  isValidTimezone,
  monthlyDays,
  schedulePayload,
  scheduleToCron,
  timeOfDayPreset,
  validateSchedule,
} from '../src/lib/schedule';

describe('scheduleToCron', () => {
  it('maps every preset to the same expression the server uses', () => {
    expect(scheduleToCron({ ...defaultSchedule('UTC'), preset: 'daily', hour: 7, minute: 5 })).toBe('5 7 * * *');
    expect(
      scheduleToCron({ ...defaultSchedule('UTC'), preset: 'weekdays', hour: 8, minute: 0, weekdays: [1, 3, 5] }),
    ).toBe('0 8 * * 1,3,5');
    expect(
      scheduleToCron({ ...defaultSchedule('UTC'), preset: 'weekly', hour: 18, minute: 30, weekdays: [2] }),
    ).toBe('30 18 * * 2');
    expect(
      scheduleToCron({ ...defaultSchedule('UTC'), preset: 'weekly', hour: 18, minute: 30, weekdays: [1, 3] }),
    ).toBe('30 18 * * 1,3');
    expect(
      scheduleToCron({ ...defaultSchedule('UTC'), preset: 'monthly', hour: 6, minute: 15, dayOfMonth: 15, daysOfMonth: undefined }),
    ).toBe('15 6 15 * *');
    expect(
      scheduleToCron({
        ...defaultSchedule('UTC'),
        preset: 'monthly',
        hour: 6,
        minute: 15,
        daysOfMonth: [1, 15, 28],
      }),
    ).toBe('15 6 1,15,28 * *');
    expect(scheduleToCron({ ...defaultSchedule('UTC'), preset: 'custom', cron: '*/5 * * * *' })).toBe('*/5 * * * *');
    expect(scheduleToCron({ ...defaultSchedule('UTC'), preset: 'once' })).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('accepts a complete daily schedule', () => {
    expect(validateSchedule(defaultSchedule('Europe/Vienna'))).toEqual([]);
  });

  it('accepts multiple weekdays for weekly and multiple days for monthly', () => {
    expect(
      validateSchedule({ ...defaultSchedule('UTC'), preset: 'weekly', weekdays: [1, 3, 5] }),
    ).toEqual([]);
    expect(
      validateSchedule({ ...defaultSchedule('UTC'), preset: 'monthly', daysOfMonth: [1, 15] }),
    ).toEqual([]);
  });

  it('rejects missing fields for once, weekly and monthly presets', () => {
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'once' })).toContain('validation.runAtRequired');
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'weekdays', weekdays: [] })).toContain(
      'validation.weekdaysRequired',
    );
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'weekly', weekdays: [] })).toContain(
      'validation.weekdaysRequired',
    );
    expect(
      validateSchedule({ ...defaultSchedule('UTC'), preset: 'monthly', daysOfMonth: [], dayOfMonth: undefined }),
    ).toContain('validation.dayOfMonthRequired');
  });

  it('validates cron expressions and timezones', () => {
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'custom', cron: '' })).toContain(
      'validation.cronRequired',
    );
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'custom', cron: '0 9 * *' })).toContain(
      'validation.cronInvalid',
    );
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'custom', cron: '0 9 * * 1-5' })).toEqual([]);
    expect(validateSchedule({ ...defaultSchedule('Mars/Olympus'), preset: 'daily' })).toContain(
      'validation.timezoneInvalid',
    );
  });

  it('knows IANA timezones', () => {
    expect(isValidTimezone('Europe/Vienna')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('monthlyDays', () => {
  it('prefers daysOfMonth and falls back to the legacy dayOfMonth', () => {
    expect(monthlyDays({ daysOfMonth: [15, 1, 15], dayOfMonth: 5 })).toEqual([1, 15]);
    expect(monthlyDays({ dayOfMonth: 5 })).toEqual([5]);
    expect(monthlyDays({})).toEqual([]);
  });
});

describe('timeOfDayPreset', () => {
  it('maps the friendly presets and falls back to custom', () => {
    expect(timeOfDayPreset(9, 0)).toBe('morning');
    expect(timeOfDayPreset(14, 0)).toBe('afternoon');
    expect(timeOfDayPreset(18, 0)).toBe('evening');
    expect(timeOfDayPreset(22, 0)).toBe('night');
    expect(timeOfDayPreset(7, 45)).toBe('custom');
  });
});

describe('schedulePayload', () => {
  it('keeps only the fields relevant to the selected preset', () => {
    const payload = schedulePayload({
      preset: 'custom',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      cron: '  30 6 * * 1  ',
      weekdays: [1, 2],
      dayOfMonth: 12,
      daysOfMonth: [12, 24],
    });
    expect(payload).toEqual({
      preset: 'custom',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      cron: '30 6 * * 1',
    });
  });

  it('sends multi-day monthly schedules and keeps the legacy day in sync', () => {
    const payload = schedulePayload({
      preset: 'monthly',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      daysOfMonth: [1, 15],
    });
    expect(payload).toEqual({
      preset: 'monthly',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      daysOfMonth: [1, 15],
      dayOfMonth: 1,
    });
  });
});
