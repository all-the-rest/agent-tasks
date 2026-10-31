import { describe, expect, it } from 'vitest';
import {
  defaultSchedule,
  isValidTimezone,
  schedulePayload,
  scheduleToCron,
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
      scheduleToCron({ ...defaultSchedule('UTC'), preset: 'monthly', hour: 6, minute: 15, dayOfMonth: 15 }),
    ).toBe('15 6 15 * *');
    expect(scheduleToCron({ ...defaultSchedule('UTC'), preset: 'custom', cron: '*/5 * * * *' })).toBe('*/5 * * * *');
    expect(scheduleToCron({ ...defaultSchedule('UTC'), preset: 'once' })).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('accepts a complete daily schedule', () => {
    expect(validateSchedule(defaultSchedule('Europe/Vienna'))).toEqual([]);
  });

  it('rejects missing fields for once, weekly and monthly presets', () => {
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'once' })).toContain('validation.runAtRequired');
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'weekdays', weekdays: [] })).toContain(
      'validation.weekdaysRequired',
    );
    expect(validateSchedule({ ...defaultSchedule('UTC'), preset: 'weekly', weekdays: [1, 2] })).toContain(
      'validation.weeklyOneDay',
    );
    expect(
      validateSchedule({ ...defaultSchedule('UTC'), preset: 'monthly', dayOfMonth: undefined }),
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
    });
    expect(payload).toEqual({
      preset: 'custom',
      timezone: 'Europe/Vienna',
      hour: 9,
      minute: 0,
      cron: '30 6 * * 1',
    });
  });
});
