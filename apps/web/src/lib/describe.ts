import type { Translator } from '../i18n';
import type { TaskSchedule } from './types';
import { monthlyDays } from './schedule';

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function weekdayList(days: number[], t: Translator): string {
  return days.map((day) => t(`weekdays.short.${day}`)).join(', ');
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
        weekday: weekdayList(schedule.weekdays?.length ? schedule.weekdays : [1], t),
        time,
        timezone: schedule.timezone,
      });
    case 'monthly':
      return t('tasks.scheduleSummary.monthly', {
        day: monthlyDays(schedule).join(', ') || '1',
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
