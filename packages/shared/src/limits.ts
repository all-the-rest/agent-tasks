/** Fixed internal bounds for the legacy agent loop; not administrator settings. */
export const AGENT_RUNTIME_LIMITS = {
  maxDurationSec: 3600,
  maxAgentSteps: 60,
  maxPageVisits: 40,
  maxOutputBytes: 2_000_000,
  maxToolCalls: 120,
  maxSearchQueries: 20,
} as const;
