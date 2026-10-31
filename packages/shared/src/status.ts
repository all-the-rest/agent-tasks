export const EXECUTION_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const FINAL_STATUSES: readonly ExecutionStatus[] = ['completed', 'failed', 'cancelled', 'timed_out'];

export const ROLES = ['ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export const REPORT_CONFIDENCE = ['verified', 'secondary', 'inference', 'unknown'] as const;
export type Confidence = (typeof REPORT_CONFIDENCE)[number];
