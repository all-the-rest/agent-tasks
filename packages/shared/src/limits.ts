import { z } from 'zod';

export const HARD_LIMITS = {
  maxDurationSec: 3600,
  maxAgentSteps: 60,
  maxPageVisits: 40,
  maxOutputBytes: 2_000_000,
  maxToolCalls: 120,
  maxSearchQueries: 20,
} as const;

// Runs use the finite hard caps by default. Administrators may lower these
// global budgets, but individual task owners cannot choose their own limits.
export const DEFAULT_LIMITS = HARD_LIMITS;

export const limitsSchema = z.object({
  maxDurationSec: z.number().int().min(30).max(HARD_LIMITS.maxDurationSec).default(DEFAULT_LIMITS.maxDurationSec),
  maxAgentSteps: z.number().int().min(1).max(HARD_LIMITS.maxAgentSteps).default(DEFAULT_LIMITS.maxAgentSteps),
  maxPageVisits: z.number().int().min(0).max(HARD_LIMITS.maxPageVisits).default(DEFAULT_LIMITS.maxPageVisits),
  maxOutputBytes: z.number().int().min(1_000).max(HARD_LIMITS.maxOutputBytes).default(DEFAULT_LIMITS.maxOutputBytes),
  maxToolCalls: z.number().int().min(1).max(HARD_LIMITS.maxToolCalls).default(DEFAULT_LIMITS.maxToolCalls),
  maxSearchQueries: z.number().int().min(0).max(HARD_LIMITS.maxSearchQueries).default(DEFAULT_LIMITS.maxSearchQueries),
});

export type Limits = z.infer<typeof limitsSchema>;
