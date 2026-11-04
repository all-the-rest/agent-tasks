import { z } from 'zod';

/**
 * Absolute per-run ceilings. Administrators may lower a global budget in the
 * system settings, but no task owner and no stored task may raise one above
 * these values.
 */
export const HARD_LIMITS = {
  maxDurationSec: 3600,
  maxAgentSteps: 60,
  maxPageVisits: 40,
  maxOutputBytes: 2_000_000,
  maxToolCalls: 120,
  maxSearchQueries: 20,
} as const;

/** Defaults are the finite hard caps: an unconfigured instance stays bounded. */
export const DEFAULT_LIMITS = HARD_LIMITS;

/** Fixed hard ceilings retained as the default limits alias. */
export const AGENT_RUNTIME_LIMITS = HARD_LIMITS;

const LIMIT_BOUNDS = {
  maxDurationSec: { min: 30, max: HARD_LIMITS.maxDurationSec },
  maxAgentSteps: { min: 1, max: HARD_LIMITS.maxAgentSteps },
  maxPageVisits: { min: 0, max: HARD_LIMITS.maxPageVisits },
  maxOutputBytes: { min: 1_000, max: HARD_LIMITS.maxOutputBytes },
  maxToolCalls: { min: 1, max: HARD_LIMITS.maxToolCalls },
  maxSearchQueries: { min: 0, max: HARD_LIMITS.maxSearchQueries },
} as const;

const LIMIT_KEYS = Object.keys(HARD_LIMITS) as Array<keyof typeof HARD_LIMITS>;

/**
 * Global per-run budgets as stored in the administrator settings. Values are
 * validated against `HARD_LIMITS`, so a stored setting can only lower a budget.
 */
export const limitsSchema = z.object({
  maxDurationSec: z.number().int().min(LIMIT_BOUNDS.maxDurationSec.min).max(HARD_LIMITS.maxDurationSec).default(DEFAULT_LIMITS.maxDurationSec),
  maxAgentSteps: z.number().int().min(LIMIT_BOUNDS.maxAgentSteps.min).max(HARD_LIMITS.maxAgentSteps).default(DEFAULT_LIMITS.maxAgentSteps),
  maxPageVisits: z.number().int().min(LIMIT_BOUNDS.maxPageVisits.min).max(HARD_LIMITS.maxPageVisits).default(DEFAULT_LIMITS.maxPageVisits),
  maxOutputBytes: z.number().int().min(LIMIT_BOUNDS.maxOutputBytes.min).max(HARD_LIMITS.maxOutputBytes).default(DEFAULT_LIMITS.maxOutputBytes),
  maxToolCalls: z.number().int().min(LIMIT_BOUNDS.maxToolCalls.min).max(HARD_LIMITS.maxToolCalls).default(DEFAULT_LIMITS.maxToolCalls),
  maxSearchQueries: z.number().int().min(LIMIT_BOUNDS.maxSearchQueries.min).max(HARD_LIMITS.maxSearchQueries).default(DEFAULT_LIMITS.maxSearchQueries),
});
export type Limits = z.infer<typeof limitsSchema>;

/**
 * Read the global per-run budgets defensively from persisted or injected
 * settings. Missing fields and non-numeric values fall back to the finite
 * defaults; numeric values are clamped into their allowed range and can never
 * exceed a hard cap. Unlike the API schema this never throws inside a run.
 */
export function resolveAgentLimits(value: unknown): Limits {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const resolved: Record<keyof Limits, number> = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    const raw = source[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const bounds = LIMIT_BOUNDS[key];
    resolved[key] = Math.min(bounds.max, Math.max(bounds.min, Math.floor(raw)));
  }
  return resolved;
}
