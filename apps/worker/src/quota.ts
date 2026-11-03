export interface ExecutionBudget {
  /**
   * Other executions admitted to run for this owner in the last 24 hours. A retry
   * of an execution already admitted in that window does not consume another slot.
   */
  priorExecutionsToday: number;
  /**
   * Executions of this owner currently `running`. The candidate is still queued while
   * this budget is checked, then the slot reservation and status change commit together.
   */
  otherRunningForOwner: number;
}

export interface ExecutionLimits {
  maxTaskExecutionsPerDay: number;
  maxConcurrentExecutionsPerUser: number;
}

export type LimitRefusal = 'quota' | 'concurrency';

/**
 * The execution that *would exceed* the limit is refused: with a limit of N, N earlier
 * executions are allowed and the one after them is not. Both values count only other
 * executions, hence `>=` (N others already fill the budget).
 */
export function exceededExecutionLimit(budget: ExecutionBudget, limits: ExecutionLimits): LimitRefusal | null {
  if (budget.priorExecutionsToday >= limits.maxTaskExecutionsPerDay) return 'quota';
  if (budget.otherRunningForOwner >= limits.maxConcurrentExecutionsPerUser) return 'concurrency';
  return null;
}
