import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatDuration } from '../src/lib/format';
import { describeSchedule } from '../src/lib/describe';
import { defaultSchedule } from '../src/lib/schedule';
import type { Translator } from '../i18n';

const fakeT = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as Translator;

describe('formatDuration', () => {
  it('renders milliseconds, seconds and minutes', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(1_500)).toBe('1.5 s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('uses decimal units', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_000)).toBe('12 kB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });
});

describe('formatDate', () => {
  it('returns a placeholder for missing values', () => {
    expect(formatDate(null, 'en')).toBe('—');
    expect(formatDate('not-a-date', 'de')).toBe('—');
    expect(formatDate('2026-10-31T10:00:00.000Z', 'en')).not.toBe('—');
  });
});

describe('describeSchedule', () => {
  it('localises every preset through translation keys', () => {
    expect(describeSchedule(defaultSchedule('Europe/Vienna'), fakeT)).toContain('tasks.scheduleSummary.daily');
    expect(
      describeSchedule({ ...defaultSchedule('Europe/Vienna'), preset: 'weekly', weekdays: [3] }, fakeT),
    ).toContain('tasks.scheduleSummary.weekly');
    expect(
      describeSchedule({ ...defaultSchedule('Europe/Vienna'), preset: 'custom', cron: '0 9 * * 1' }, fakeT),
    ).toContain('tasks.scheduleSummary.custom');
  });
});
