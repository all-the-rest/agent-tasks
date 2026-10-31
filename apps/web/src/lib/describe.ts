import type { Translator } from '../i18n';
import type { TaskSchedule } from './types';

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function describeSchedule(schedule: TaskSchedule, t: Translator): string {
  const time = clock(schedule.hour, schedule.minute);
  switch (schedule.preset) {
    case 'once':
      return t('tasks.scheduleSummary.once', {
        time: schedule.runAt ? new Date(schedule.runAt).toLocaleString() : time,
        timezone: schedule.timezone,
      });
    case 'daily':
      return t('tasks.scheduleSummary.daily', { time, timezone: schedule.timezone });
    case 'weekdays':
      return t('tasks.scheduleSummary.weekdays', { time, timezone: schedule.timezone });
    case 'weekly':
      return t('tasks.scheduleSummary.weekly', {
        weekday: t(`weekdays.long.${schedule.weekdays?.[0] ?? 1}`),
        time,
        timezone: schedule.timezone,
      });
    case 'monthly':
      return t('tasks.scheduleSummary.monthly', {
        day: schedule.dayOfMonth ?? 1,
        time,
        timezone: schedule.timezone,
      });
    case 'custom':
      return t('tasks.scheduleSummary.custom', {
        cron: schedule.cron ?? '',
        timezone: schedule.timezone,
      });
  }
}
