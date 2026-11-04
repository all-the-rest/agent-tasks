import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * Durable, per-execution tool budgets.
 *
 * The OpenCode tool bridge used to keep its call/page/search counters in memory.
 * A pg-boss retry or a crash recovery therefore started with a fresh allowance,
 * even though the same execution row continued. These reservations live in
 * `execution_budget_counters`, keyed by execution id only, so neither a retry
 * (`attempt` increments) nor a recovery (the row is re-queued) resets them.
 *
 * Contract for callers (the worker):
 *
 * - Reserve **before** the side effect. A `reserved` result is the permission to
 *   act; `exhausted` and `denied` mean do not act.
 * - A reservation is never given back, even when the tool or provider call
 *   fails. That keeps the limit fail-closed and independent of error handling.
 * - The reservation validates the execution at commit time: the caller's owner
 *   and worker must match, the execution must still be `running`, its lease must
 *   be active, and cancellation must not have been requested. A stale worker can
 *   therefore never spend from a recovered execution.
 * - Limits are pinned on the first reservation and only ever tighten. Passing a
 *   larger limit on a retry cannot widen an already-started budget.
 * - A database error is not a refusal object: it propagates. Callers must treat a
 *   throw as "do not act" as well.
 * - `outputBytes` is a **cumulative** per-execution total, not the per-tool-reply
 *   truncation the OpenCode bridge performs today. Only pass a
 *   `maxOutputBytes` limit when a run-wide cap is intended. If both apply,
 *   truncate the reply to the per-reply cap first and reserve the bytes actually
 *   emitted; otherwise a 2 MB per-reply cap would silently become a 2 MB
 *   whole-run cap.
 *
 * All counters of one request are reserved by a single conditional UPDATE, so a
 * request such as `{ calls: 1, pages: 1 }` either consumes both or neither. The
 * execution row is locked first, which serialises concurrently arriving tool
 * calls of the same run across worker processes as well as across connections.
 */

export const EXECUTION_BUDGET_COUNTERS = ['calls', 'pages', 'searches', 'outputBytes'] as const;

export type ExecutionBudgetCounter = (typeof EXECUTION_BUDGET_COUNTERS)[number];

/** The task's execution limits, named as the worker already receives them. */
export interface ExecutionBudgetLimits {
  maxToolCalls: number;
  maxPageVisits: number;
  maxSearchQueries: number;
  /**
   * Optional **cumulative** output cap for the whole execution. Omitted or null
   * accounts output without a cap. This is deliberately separate from the
   * per-tool-reply truncation applied by the bridge.
   */
  maxOutputBytes?: number | null;
}

export interface ExecutionBudgetIdentity {
  executionId: string;
  ownerId: string;
  workerId: string;
}

export interface ExecutionBudgetRequest extends ExecutionBudgetIdentity {
  limits: ExecutionBudgetLimits;
  /** Counters to consume atomically. At least one amount must be positive. */
  counters: Partial<Record<ExecutionBudgetCounter, number>>;
}

export interface ExecutionBudgetUsage {
  calls: number;
  pages: number;
  searches: number;
  outputBytes: number;
}

export interface ExecutionBudgetLimitsState {
  maxCalls: number;
  maxPages: number;
  maxSearches: number;
  maxOutputBytes: number | null;
}

export interface ExecutionBudgetRemaining {
  calls: number;
  pages: number;
  searches: number;
  /** Null when the run accounts output without a cumulative cap. */
  outputBytes: number | null;
}

export interface ExecutionBudgetState {
  usage: ExecutionBudgetUsage;
  limits: ExecutionBudgetLimitsState;
  remaining: ExecutionBudgetRemaining;
}

export type ExecutionBudgetDenialReason =
  | 'execution_not_found'
  | 'owner_mismatch'
  | 'worker_mismatch'
  | 'not_running'
  | 'cancelled'
  | 'lease_expired';

export type ExecutionBudgetResult =
  | ({ status: 'reserved' } & ExecutionBudgetState)
  | ({ status: 'exhausted'; counter: ExecutionBudgetCounter } & ExecutionBudgetState)
  | { status: 'denied'; reason: ExecutionBudgetDenialReason };

interface BudgetRow extends Record<string, unknown> {
  calls: number | string;
  pages: number | string;
  searches: number | string;
  output_bytes: number | string;
  max_calls: number | string;
  max_pages: number | string;
  max_searches: number | string;
  max_output_bytes: number | string | null;
}

interface ExecutionLeaseRow extends Record<string, unknown> {
  owner_id: string;
  worker_id: string | null;
  status: string;
  cancel_requested: boolean;
  lease_active: boolean;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const BUDGET_COLUMNS = sql`
  calls, pages, searches, output_bytes, max_calls, max_pages, max_searches, max_output_bytes
`;

function normalizeLimit(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative integer`);
  }
  return value;
}

function normalizeOptionalLimit(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  return normalizeLimit(value, label);
}

function normalizeAmount(value: number, counter: ExecutionBudgetCounter): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`reservation amount for ${counter} must be a positive integer`);
  }
  return value;
}

function toState(row: BudgetRow): ExecutionBudgetState {
  const usage: ExecutionBudgetUsage = {
    calls: Number(row.calls),
    pages: Number(row.pages),
    searches: Number(row.searches),
    outputBytes: Number(row.output_bytes),
  };
  const limits: ExecutionBudgetLimitsState = {
    maxCalls: Number(row.max_calls),
    maxPages: Number(row.max_pages),
    maxSearches: Number(row.max_searches),
    maxOutputBytes: row.max_output_bytes === null ? null : Number(row.max_output_bytes),
  };
  return {
    usage,
    limits,
    remaining: {
      calls: Math.max(0, limits.maxCalls - usage.calls),
      pages: Math.max(0, limits.maxPages - usage.pages),
      searches: Math.max(0, limits.maxSearches - usage.searches),
      outputBytes:
        limits.maxOutputBytes === null
          ? null
          : Math.max(0, limits.maxOutputBytes - usage.outputBytes),
    },
  };
}

function denied(reason: ExecutionBudgetDenialReason): ExecutionBudgetResult {
  return { status: 'denied', reason };
}

/**
 * Returns the first counter whose requested amount would cross its limit. The
 * conditional UPDATE already refused the whole request, so this only explains
 * which bound was hit (in the stable order calls, pages, searches, output).
 */
function exhaustedCounter(
  requested: Record<ExecutionBudgetCounter, number>,
  state: ExecutionBudgetState,
): ExecutionBudgetCounter {
  if (requested.calls > 0 && state.usage.calls + requested.calls > state.limits.maxCalls) {
    return 'calls';
  }
  if (requested.pages > 0 && state.usage.pages + requested.pages > state.limits.maxPages) {
    return 'pages';
  }
  if (requested.searches > 0 && state.usage.searches + requested.searches > state.limits.maxSearches) {
    return 'searches';
  }
  if (
    requested.outputBytes > 0 &&
    state.limits.maxOutputBytes !== null &&
    state.usage.outputBytes + requested.outputBytes > state.limits.maxOutputBytes
  ) {
    return 'outputBytes';
  }
  // The UPDATE only refuses when one of the predicates above is false. Reaching
  // this point means the stored counters changed in a way this function cannot
  // explain; fail closed instead of inventing an allowance.
  throw new Error('execution budget reservation was refused without an exhausted counter');
}

async function readRow(
  tx: Transaction | Database,
  executionId: string,
): Promise<BudgetRow | undefined> {
  const result = await tx.execute<BudgetRow>(sql`
    select ${BUDGET_COLUMNS}
    from execution_budget_counters
    where execution_id = ${executionId}
  `);
  return result.rows[0];
}

/**
 * Atomically validates the execution lease and consumes one or more counters.
 *
 * The validation, the lazy initialisation of the counter row and the conditional
 * increment all run in one database transaction. The `for update` lock on the
 * execution row makes a burst of concurrent calls from the same execution commit
 * one after another; the increment itself is additionally guarded by SQL
 * predicates, so even without that lock a counter can never exceed its maximum.
 */
export async function reserveExecutionBudget(
  db: Database,
  input: ExecutionBudgetRequest,
): Promise<ExecutionBudgetResult> {
  const requested = {} as Record<ExecutionBudgetCounter, number>;
  for (const counter of EXECUTION_BUDGET_COUNTERS) {
    const amount = input.counters[counter];
    requested[counter] = amount === undefined ? 0 : normalizeAmount(amount, counter);
  }
  if (EXECUTION_BUDGET_COUNTERS.every((counter) => requested[counter] === 0)) {
    throw new RangeError('at least one execution budget counter must be reserved');
  }

  const maxCalls = normalizeLimit(input.limits.maxToolCalls, 'maxToolCalls');
  const maxPages = normalizeLimit(input.limits.maxPageVisits, 'maxPageVisits');
  const maxSearches = normalizeLimit(input.limits.maxSearchQueries, 'maxSearchQueries');
  const maxOutputBytes = normalizeOptionalLimit(input.limits.maxOutputBytes, 'maxOutputBytes');

  return db.transaction(async (tx) => {
    // One row lock per execution: this orders concurrent reservations and makes
    // the lease/cancellation check authoritative for the whole transaction.
    const lease = await tx.execute<ExecutionLeaseRow>(sql`
      select owner_id,
             worker_id,
             status,
             cancel_requested,
             coalesce(lease_expires_at > now(), false) as lease_active
      from executions
      where id = ${input.executionId}
      for update
    `);
    const execution = lease.rows[0];
    if (!execution) return denied('execution_not_found');
    if (execution.owner_id !== input.ownerId) return denied('owner_mismatch');
    if (execution.worker_id !== input.workerId) return denied('worker_mismatch');
    if (execution.status !== 'running') return denied('not_running');
    if (execution.cancel_requested) return denied('cancelled');
    if (!execution.lease_active) return denied('lease_expired');

    // The first reservation creates the durable row. A retry or recovery inserts
    // nothing: `least` only lowers the maxima, and a null max stays null unless a
    // concrete cap is supplied (which then tightens it).
    await tx.execute(sql`
      insert into execution_budget_counters
        (execution_id, owner_id, max_calls, max_pages, max_searches, max_output_bytes)
      values (
        ${input.executionId},
        ${execution.owner_id},
        ${maxCalls},
        ${maxPages},
        ${maxSearches},
        ${maxOutputBytes}
      )
      on conflict (execution_id) do update set
        max_calls = least(execution_budget_counters.max_calls, excluded.max_calls),
        max_pages = least(execution_budget_counters.max_pages, excluded.max_pages),
        max_searches = least(execution_budget_counters.max_searches, excluded.max_searches),
        max_output_bytes = case
          when execution_budget_counters.max_output_bytes is null then excluded.max_output_bytes
          when excluded.max_output_bytes is null then execution_budget_counters.max_output_bytes
          else least(execution_budget_counters.max_output_bytes, excluded.max_output_bytes)
        end,
        updated_at = now()
    `);

    // One statement, all-or-nothing. A zero delta for an unrequested counter is a
    // no-op and its predicate is always true.
    const updated = await tx.execute<BudgetRow>(sql`
      update execution_budget_counters
      set calls = calls + ${requested.calls},
          pages = pages + ${requested.pages},
          searches = searches + ${requested.searches},
          output_bytes = output_bytes + ${requested.outputBytes},
          updated_at = now()
      where execution_id = ${input.executionId}
        and calls + ${requested.calls} <= max_calls
        and pages + ${requested.pages} <= max_pages
        and searches + ${requested.searches} <= max_searches
        and (
          ${requested.outputBytes} = 0
          or max_output_bytes is null
          or output_bytes + ${requested.outputBytes} <= max_output_bytes
        )
      returning ${BUDGET_COLUMNS}
    `);

    const reserved = updated.rows[0];
    if (reserved) return { status: 'reserved', ...toState(reserved) };

    const current = await readRow(tx, input.executionId);
    if (!current) {
      // The execution row was locked and the counter row inserted above, so this
      // can only happen if the row vanished in a way this contract does not allow.
      throw new Error('execution budget row disappeared during reservation');
    }
    const state = toState(current);
    return { status: 'exhausted', counter: exhaustedCounter(requested, state), ...state };
  });
}

/**
 * Owner-scoped read of the durable counters, for reporting and diagnostics. It
 * intentionally does not require a live lease: a finished execution keeps its
 * final usage. Returns null for an unknown execution or a different owner.
 */
export async function readExecutionBudget(
  db: Database,
  input: { executionId: string; ownerId: string },
): Promise<ExecutionBudgetState | null> {
  const result = await db.execute<BudgetRow>(sql`
    select b.calls, b.pages, b.searches, b.output_bytes,
           b.max_calls, b.max_pages, b.max_searches, b.max_output_bytes
    from execution_budget_counters b
    join executions e on e.id = b.execution_id
    where b.execution_id = ${input.executionId} and e.owner_id = ${input.ownerId}
  `);
  const row = result.rows[0];
  return row ? toState(row) : null;
}
