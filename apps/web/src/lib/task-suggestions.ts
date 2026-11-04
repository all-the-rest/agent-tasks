/**
 * Starting points for the prompt composer. The ids map to
 * `tasks.suggestions.<id>.{title,prompt}` in the locale dictionaries.
 *
 * Selecting one only fills the composer draft: it never creates a task or
 * starts a run. The bracketed placeholder is intentional — the prompt is a
 * template the owner edits before continuing to the review form.
 */
export const TASK_SUGGESTION_IDS = [
  'topicBrief',
  'priceWatch',
  'deadlineSweep',
  'sourceCheck',
] as const;

export type TaskSuggestionId = (typeof TASK_SUGGESTION_IDS)[number];
