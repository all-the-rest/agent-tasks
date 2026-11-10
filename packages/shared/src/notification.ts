import { z } from 'zod';

/** Channel-oriented notification policy persisted with each task. */
export const taskNotificationSchema = z.object({
  email: z.object({ enabled: z.boolean(), when: z.enum(['always', 'on_change']) }).strict(),
}).strict();
export type TaskNotification = z.infer<typeof taskNotificationSchema>;
/** Scheduled tasks notify by email by default; owners may disable the channel. */
export const DEFAULT_TASK_NOTIFICATION: TaskNotification = { email: { enabled: true, when: 'always' } };

/** Convert legacy database/API values during rolling upgrades and migration tests. */
export function migrateLegacyNotification(value: unknown): TaskNotification {
  if (value === 'none') return { email: { enabled: false, when: 'always' } };
  if (value === 'email_on_change') return { email: { enabled: true, when: 'on_change' } };
  if (value === 'email') return { email: { enabled: true, when: 'always' } };
  return taskNotificationSchema.parse(value);
}

export function shouldSendNotification(notification: TaskNotification, changed: boolean): boolean {
  return notification.email.enabled && (notification.email.when === 'always' || changed);
}
