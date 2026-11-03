import { z } from 'zod';

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'date must be a valid calendar date');

export const taskEndConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('never') }),
  z.object({ type: z.literal('on_date'), date: calendarDateSchema }),
  z.object({ type: z.literal('after_runs'), runs: z.number().int().min(1).max(2_147_483_647) }),
]);

export type TaskEndCondition = z.infer<typeof taskEndConditionSchema>;

/** Returns the calendar date at an instant in the schedule's IANA timezone. */
export function localDateAt(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Date end conditions include the entire selected local calendar day. */
export function isAfterTaskEndDate(condition: TaskEndCondition, timezone: string, instant: Date): boolean {
  return condition.type === 'on_date' && localDateAt(instant, timezone) > condition.date;
}

export function isTaskEndConditionReached(
  condition: TaskEndCondition,
  context: { timezone: string; scheduledRunCount: number; now: Date },
): boolean {
  if (condition.type === 'after_runs') return context.scheduledRunCount >= condition.runs;
  if (condition.type === 'on_date') return isAfterTaskEndDate(condition, context.timezone, context.now);
  return false;
}
