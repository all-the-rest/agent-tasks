import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { isValidTimeZone } from './time.js';

/**
 * Schedule presets are stored as data, never as opaque cron strings, so the web UI
 * can round-trip them. `custom` is the only preset that stores a raw expression.
 */
export const SCHEDULE_PRESETS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export const scheduleSchema = z
  .object({
    preset: z.enum(SCHEDULE_PRESETS),
    /** IANA timezone, e.g. `Europe/Vienna`. Timestamps stay UTC; this only locates local wall time. */
    timezone: z.string().refine(isValidTimeZone, 'unknown IANA timezone'),
    /** UTC instant for `once` schedules. */
    runAt: z.string().datetime({ offset: true }).optional(),
    hour: z.number().int().min(0).max(23).default(9),
    minute: z.number().int().min(0).max(59).default(0),
    /** 0 = Sunday … 6 = Saturday. Used by `weekdays` and `weekly`; both allow several days. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    /** Legacy single day. Superseded by `daysOfMonth` when that is present. */
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    /** 1–31. Missing days in short months are skipped by the cron iterator. */
    daysOfMonth: z.array(z.number().int().min(1).max(31)).max(31).optional(),
    /** 5-field cron expression, local to `timezone`. Only for `preset: "custom"`. */
    cron: z.string().min(5).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.preset === 'once' && !value.runAt) {
      ctx.addIssue({ code: 'custom', path: ['runAt'], message: 'a one-off schedule needs runAt' });
    }
    if ((value.preset === 'weekdays' || value.preset === 'weekly') && !value.weekdays?.length) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'select at least one weekday' });
    }
    if (value.preset === 'monthly' && !monthlyDays(value).length) {
      ctx.addIssue({ code: 'custom', path: ['daysOfMonth'], message: 'a monthly schedule needs a day of month' });
    }
    if (value.preset === 'custom') {
      if (!value.cron) {
        ctx.addIssue({ code: 'custom', path: ['cron'], message: 'a custom schedule needs a cron expression' });
        return;
      }
      try {
        CronExpressionParser.parse(value.cron, { tz: value.timezone });
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['cron'],
          message: `invalid cron expression: ${(error as Error).message}`,
        });
      }
    }
  });

export type Schedule = z.input<typeof scheduleSchema>;
export type ParsedSchedule = z.output<typeof scheduleSchema>;

/** Selected monthly days, preferring the multi-day field over the legacy single day. */
export function monthlyDays(schedule: Pick<ParsedSchedule, 'daysOfMonth' | 'dayOfMonth'>): number[] {
  if (schedule.daysOfMonth?.length) return [...new Set(schedule.daysOfMonth)].sort((a, b) => a - b);
  return schedule.dayOfMonth === undefined ? [] : [schedule.dayOfMonth];
}

export class ScheduleError extends Error {}

/** Maps a preset to the cron expression evaluated in the schedule's timezone. */
export function toCron(schedule: ParsedSchedule): string | null {
  const { preset, minute, hour, weekdays, cron } = schedule;
  switch (preset) {
    case 'once':
      return null;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * ${weekdays?.join(',') ?? '1,2,3,4,5'}`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekdays?.join(',') ?? '1'}`;
    case 'monthly':
      return `${minute} ${hour} ${monthlyDays(schedule).join(',') || '1'} * *`;
    case 'custom':
      return cron ?? null;
  }
}

/**
 * Next occurrence strictly after `from`.
 *
 * Daylight saving (Europe/Vienna, verified in packages/shared/test/schedule.test.ts):
 * - a local time that does not exist on that day (spring forward 02:00–03:00) is
 *   moved to the same wall-clock offset inside the new offset, i.e. a 02:30 job runs
 *   at 03:30 local on that day — the job is not dropped,
 * - a local time that exists twice (fall back 02:00–03:00) runs once, at the first
 *   (CEST) instant; the unique index on (task_id, scheduled_for) additionally makes
 *   a second booking of the same occurrence impossible.
 * Callers store `nextRunAt` in UTC, so a restart never replays a wall-clock guess.
 */
export function nextOccurrence(schedule: ParsedSchedule, from: Date = new Date()): Date | null {
  if (schedule.preset === 'once') {
    if (!schedule.runAt) return null;
    const at = new Date(schedule.runAt);
    return at.getTime() > from.getTime() ? at : null;
  }
  const expression = toCron(schedule);
  if (!expression) throw new ScheduleError('schedule has no cron expression');
  const iterator = CronExpressionParser.parse(expression, { tz: schedule.timezone, currentDate: from });
  return iterator.next().toDate();
}

export function isDue(schedule: ParsedSchedule, nextRunAt: Date | null, now: Date = new Date()): boolean {
  return nextRunAt !== null && nextRunAt.getTime() <= now.getTime();
}

/** Human readable preset summary; the web app localises these keys itself. */
export function describeSchedule(schedule: ParsedSchedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  switch (schedule.preset) {
    case 'once':
      return `once at ${schedule.runAt ?? '?'}`;
    case 'daily':
      return `every day ${time} ${schedule.timezone}`;
    case 'weekdays':
      return `weekdays ${time} ${schedule.timezone}`;
    case 'weekly':
      return `weekly on ${schedule.weekdays?.join(',') ?? '1'} at ${time} ${schedule.timezone}`;
    case 'monthly':
      return `monthly on day ${monthlyDays(schedule).join(',') || '1'} at ${time} ${schedule.timezone}`;
    case 'custom':
      return `cron ${schedule.cron ?? '?'} (${schedule.timezone})`;
  }
}
