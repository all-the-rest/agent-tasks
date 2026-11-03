export const TASK_PROMPT_MAX_LENGTH = 20_000;

const TASK_PROMPT_DRAFT_STATE_KEY = 'taskPromptDraft';
const TASK_PROMPT_DRAFT_OWNER_KEY = 'taskPromptDraftOwnerId';
let activeOwnerId: string | null = null;
let inMemoryTaskPromptDraft: { ownerId: string; prompt: string } | undefined;

export function isTaskPromptDraftState(state: unknown, ownerId: string): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const record = state as Record<string, unknown>;
  const prompt = record[TASK_PROMPT_DRAFT_STATE_KEY];
  return record[TASK_PROMPT_DRAFT_OWNER_KEY] === ownerId &&
    typeof prompt === 'string' &&
    prompt.length <= TASK_PROMPT_MAX_LENGTH;
}

export function taskPromptDraftFromState(state: unknown, ownerId: string): string {
  if (!isTaskPromptDraftState(state, ownerId)) return '';
  return (state as Record<string, unknown>)[TASK_PROMPT_DRAFT_STATE_KEY] as string;
}

export function taskPromptDraftState(ownerId: string, prompt: string): {
  taskPromptDraft: string;
  taskPromptDraftOwnerId: string;
} {
  return {
    taskPromptDraft: prompt.slice(0, TASK_PROMPT_MAX_LENGTH),
    taskPromptDraftOwnerId: ownerId,
  };
}

/** Rehydrates owner-validated history state before a browser Back POP can render. */
export function currentTaskPromptDraft(ownerId: string): string | undefined {
  return inMemoryTaskPromptDraft?.ownerId === ownerId && activeOwnerId === ownerId
    ? inMemoryTaskPromptDraft.prompt
    : undefined;
}

export function rememberTaskPromptDraft(ownerId: string, prompt: string): void {
  if (!ownerId || activeOwnerId !== ownerId) return;
  inMemoryTaskPromptDraft = { ownerId, prompt: prompt.slice(0, TASK_PROMPT_MAX_LENGTH) };
}

/** An empty value overrides an older history entry after successful creation. */
export function clearTaskPromptDraft(ownerId: string): void {
  if (activeOwnerId !== ownerId) return;
  inMemoryTaskPromptDraft = { ownerId, prompt: '' };
}

/** Auth transitions invalidate prompt memory before another account can render. */
export function setTaskPromptDraftOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  inMemoryTaskPromptDraft = undefined;
}

export function resetTaskPromptDraftMemory(): void {
  inMemoryTaskPromptDraft = undefined;
}
