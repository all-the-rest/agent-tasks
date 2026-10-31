# Durable scheduling: pg-boss, leases, retries, cancellation, recovery

_Labels: none_

## Goal

Recurring tasks survive restarts and never double-book an occurrence.

## Acceptance criteria

- [x] pg-boss queues for the tick, the recovery sweep and each execution
- [x] Transactional booking: `FOR UPDATE SKIP LOCKED` + unique `(task_id, scheduled_for)`
- [x] Multiple workers safe against each other (claim flips `queued → running`)
- [x] Execution leases and crash recovery (requeue, or cancel when cancellation was requested)
- [x] Retries with backoff for transient provider failures (max 3 attempts)
- [x] Execution timeouts and cancellation polling
- [x] Per-user concurrency and daily quota
- [x] Graceful shutdown aborts running executions
- [x] Documented at-least-once semantics

## Evidence

`test/integration/scheduler.test.ts` (6 tests): single booking, idempotent tick, concurrent
ticks, paused tasks, database-level duplicate rejection, single claim, stale-lease recovery.
