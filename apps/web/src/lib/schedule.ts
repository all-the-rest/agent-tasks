import type { TaskSchedule } from './types';

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** Friendly time-of-day choices; `custom` exposes the hour/minute inputs. */
export const TIME_OF_DAY_PRESETS = [
  { id: 'morning', hour: 9, minute: 0 },
  { id: 'afternoon', hour: 14, minute: 0 },
  { id: 'evening', hour: 18, minute: 0 },
  { id: 'night', hour: 22, minute: 0 },
] as const;

export type TimeOfDayPreset = (typeof TIME_OF_DAY_PRESETS)[number]['id'];
export type TimePreset = TimeOfDayPreset | 'custom';

/** Returns the matching preset id, or `custom` when the wall clock is not one of them. */
export function timeOfDayPreset(hour: number, minute: number): TimePreset {
  const match = TIME_OF_DAY_PRESETS.find((preset) => preset.hour === hour && preset.minute === minute);
  return match?.id ?? 'custom';
}

export function defaultSchedule(timezone: string): TaskSchedule {
  return {
    preset: 'daily',
    timezone,
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    daysOfMonth: [1],
    cron: '0 9 * * *',
  };
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Selected monthly days, preferring the multi-day field over the legacy single day. */
export function monthlyDays(schedule: Pick<TaskSchedule, 'daysOfMonth' | 'dayOfMonth'>): number[] {
  if (schedule.daysOfMonth?.length) {
    return [...new Set(schedule.daysOfMonth)].sort((a, b) => a - b);
  }
  return schedule.dayOfMonth === undefined ? [] : [schedule.dayOfMonth];
}

/** Mirrors the server-side preset-to-cron mapping, without needing cron-parser in the browser. */
export function scheduleToCron(schedule: TaskSchedule): string | null {
  const { preset, minute, hour, weekdays, cron } = schedule;
  switch (preset) {
    case 'once':
      return null;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * ${weekdays?.length ? weekdays.join(',') : '1,2,3,4,5'}`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekdays?.length ? weekdays.join(',') : '1'}`;
    case 'monthly':
      return `${minute} ${hour} ${monthlyDays(schedule).join(',') || '1'} * *`;
    case 'custom':
      return cron?.trim() || null;
  }
}

/**
 * Client-side schedule validation. Returns translation keys so the UI can localise
 * every message; the server remains the authority and re-validates the payload.
 */
export function validateSchedule(schedule: TaskSchedule): string[] {
  const errors: string[] = [];
  if (!isValidTimezone(schedule.timezone)) errors.push('validation.timezoneInvalid');

  if (schedule.preset === 'once' && !schedule.runAt) errors.push('validation.runAtRequired');
  if (
    (schedule.preset === 'weekdays' || schedule.preset === 'weekly') &&
    (schedule.weekdays?.length ?? 0) === 0
  ) {
    errors.push('validation.weekdaysRequired');
  }
  if (schedule.preset === 'monthly' && monthlyDays(schedule).length === 0) {
    errors.push('validation.dayOfMonthRequired');
  }
  if (schedule.preset === 'custom') {
    const cron = schedule.cron?.trim() ?? '';
    if (!cron) errors.push('validation.cronRequired');
    else if (!/^\s*\S+(\s+\S+){4}\s*$/.test(cron)) errors.push('validation.cronInvalid');
  }
  if (schedule.hour < 0 || schedule.hour > 23 || schedule.minute < 0 || schedule.minute > 59) {
    errors.push('validation.timeInvalid');
  }
  return errors;
}

export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const diff = new Date(date).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function schedulePayload(schedule: TaskSchedule): TaskSchedule {
  const base: TaskSchedule = {
    preset: schedule.preset,
    timezone: schedule.timezone,
    hour: schedule.hour,
    minute: schedule.minute,
  };
  if (schedule.preset === 'once') base.runAt = schedule.runAt;
  if (schedule.preset === 'weekdays' || schedule.preset === 'weekly') {
    base.weekdays = schedule.weekdays ?? [];
  }
  if (schedule.preset === 'monthly') {
    const days = monthlyDays(schedule);
    base.daysOfMonth = days;
    // Keep the legacy field in sync for older readers of the payload.
    base.dayOfMonth = days[0] ?? 1;
  }
  if (schedule.preset === 'custom') base.cron = schedule.cron?.trim();
  return base;
}

export function timezonesWith(current: string): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  const unique = new Set<string>(zones);
  unique.add('UTC');
  if (current) unique.add(current);
  return [...unique].sort();
}
