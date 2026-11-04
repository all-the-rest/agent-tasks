import { z } from 'zod';
import { scheduleSchema } from './schedule.js';

/**
 * The complete, closed set of fields a share link exposes.
 *
 * A share is a frozen definition, never a view into the live task: description,
 * system instructions, provider/model, credentials, memory, limits, run history
 * and the owner identity are deliberately absent. `.strict()` is part of the
 * contract — a stored snapshot carrying an unexpected field is refused instead
 * of being silently forwarded to the public route.
 */
export const taskShareSnapshotSchema = z
  .object({
    title: z.string().min(3).max(160),
    prompt: z.string().min(10).max(20_000),
    schedule: scheduleSchema,
    timezone: z.string().min(1).max(64),
  })
  .strict()
  .refine((value) => value.timezone === value.schedule.timezone, {
    path: ['timezone'],
    message: 'timezone must match the schedule timezone',
  });

export type TaskShareSnapshot = z.infer<typeof taskShareSnapshotSchema>;

/**
 * Adopting a share is a copy-on-adopt of that frozen definition. The adopter
 * always supplies their own provider and model; the schema is strict so a
 * request cannot smuggle credentials, memory or history into the new task.
 */
export const taskShareAdoptSchema = z
  .object({
    providerId: z.string().uuid(),
    model: z.string().trim().min(1).max(120),
  })
  .strict();

export type TaskShareAdopt = z.infer<typeof taskShareAdoptSchema>;
