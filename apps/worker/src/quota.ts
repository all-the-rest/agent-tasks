export interface ExecutionBudget {
  /**
   * Executions created for this owner in the last 24 hours, **excluding the execution
   * being decided**. That execution already exists (it is created before it is queued),
   * so counting it again would shorten the quota by one.
   */
  priorExecutionsToday: number;
  /**
   * Executions of this owner currently `running`, **excluding the execution being
   * decided**. It was flipped to `running` by the claim before this check, so counting
   * it again would shorten the concurrency limit by one.
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
 * executions are allowed and the one after them is not. Both values in `budget` exclude
 * the current execution, hence `>=` (N earlier ones already fill the budget).
 */
export function exceededExecutionLimit(budget: ExecutionBudget, limits: ExecutionLimits): LimitRefusal | null {
  if (budget.priorExecutionsToday >= limits.maxTaskExecutionsPerDay) return 'quota';
  if (budget.otherRunningForOwner >= limits.maxConcurrentExecutionsPerUser) return 'concurrency';
  return null;
}
