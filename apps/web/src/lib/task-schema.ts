import { z } from 'zod';
import { taskEndConditionSchema } from '@agent-tasks/shared/task-end-condition';
import type { TaskInput } from './types';
import { schedulePayload } from './schedule';

const scheduleFormSchema = z.object({
  preset: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly', 'custom']),
  timezone: z.string().min(1, 'validation.timezoneRequired'),
  runAt: z.string().optional(),
  hour: z.number().int().min(0, 'validation.timeInvalid').max(23, 'validation.timeInvalid'),
  minute: z.number().int().min(0, 'validation.timeInvalid').max(59, 'validation.timeInvalid'),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  daysOfMonth: z.array(z.number().int().min(1).max(31)).optional(),
  timePreset: z.enum(['morning', 'afternoon', 'evening', 'night', 'custom']).optional(),
  cron: z.string().optional(),
});

export const taskFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, 'validation.titleMin')
      .max(160, 'validation.titleMax'),
    description: z.string().max(2_000, 'validation.descriptionMax'),
    prompt: z
      .string()
      .trim()
      .min(10, 'validation.promptMin')
      .max(20_000, 'validation.promptMax'),
    systemInstructions: z.string().max(8_000, 'validation.instructionsMax'),
    providerId: z.string().uuid('validation.providerRequired'),
    model: z.string().min(1, 'validation.modelRequired'),
    enabled: z.boolean(),
    schedule: scheduleFormSchema,
    endCondition: z.object({
      type: z.enum(['never', 'on_date', 'after_runs']),
      date: z.string().optional(),
      runs: z.number().int().optional(),
    }),
    allowWebResearch: z.boolean(),
    notification: z.object({ email: z.object({ enabled: z.boolean(), when: z.enum(['always', 'on_change']) }) }),
    memorySettings: z.object({
      mode: z.enum(['off', 'suggest', 'auto']),
      contextBytes: z.number().int().min(1_000, 'validation.range').max(100_000, 'validation.range'),
    }),
    conversationMode: z.enum(['standalone', 'conversation']),
  })
  .superRefine((value, ctx) => {
    const { schedule } = value;
    if (schedule.preset === 'once' && !schedule.runAt) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'runAt'], message: 'validation.runAtRequired' });
    }
    if (schedule.preset === 'weekdays' && (schedule.weekdays?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'weekdays'], message: 'validation.weekdaysRequired' });
    }
    if (schedule.preset === 'weekly' && (schedule.weekdays?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'weekdays'], message: 'validation.weekdaysRequired' });
    }
    if (
      schedule.preset === 'monthly' &&
      !(schedule.daysOfMonth?.length ?? 0) &&
      schedule.dayOfMonth === undefined
    ) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'daysOfMonth'], message: 'validation.dayOfMonthRequired' });
    }
    if (schedule.preset === 'custom' && !schedule.cron?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'cron'], message: 'validation.cronRequired' });
    }

    const { endCondition } = value;
    const parsedEndCondition =
      endCondition.type === 'never'
        ? taskEndConditionSchema.safeParse({ type: endCondition.type })
        : endCondition.type === 'on_date'
          ? taskEndConditionSchema.safeParse({ type: endCondition.type, date: endCondition.date })
          : taskEndConditionSchema.safeParse({ type: endCondition.type, runs: endCondition.runs });
    if (!parsedEndCondition.success) {
      const field = endCondition.type === 'on_date' ? 'date' : 'runs';
      ctx.addIssue({ code: 'custom', path: ['endCondition', field], message: 'validation.endConditionInvalid' });
    }
  });

export type TaskFormValues = z.infer<typeof taskFormSchema>;

export function toTaskInput(values: TaskFormValues): TaskInput {
  const endCondition =
    values.endCondition.type === 'never'
      ? { type: 'never' as const }
      : values.endCondition.type === 'on_date'
        ? { type: 'on_date' as const, date: values.endCondition.date ?? '' }
        : { type: 'after_runs' as const, runs: values.endCondition.runs ?? 0 };
  return {
    title: values.title.trim(),
    description: values.description.trim() || undefined,
    prompt: values.prompt.trim(),
    systemInstructions: values.systemInstructions.trim() || undefined,
    providerId: values.providerId,
    model: values.model,
    enabled: values.enabled,
    schedule: schedulePayload(values.schedule),
    endCondition,
    allowWebResearch: values.allowWebResearch,
    notification: values.notification,
    memorySettings: values.memorySettings,
    conversationMode: values.conversationMode,
  };
}
