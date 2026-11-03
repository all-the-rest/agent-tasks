# Architecture overview

## Processes

| Process | Responsibility | State |
| --- | --- | --- |
| `api` | REST, Better Auth, RBAC, audit, task CRUD, run-now; serves the built SPA | Postgres |
| `worker` | pg-boss queues, scheduler tick, agent execution, leases | Postgres |
| `opencode` | Version-pinned OpenCode V2 HTTP server for the integration spike; no public port | Private worker-only network + persistent OpenCode data volume |
| `browser-runner` | Chromium sessions, egress policy | in-memory only |
| `postgres` | all persistence, including the pg-boss schema | volume |
| `searxng` (profile `search`) | web search backend; not started by default | none |

A TLS-terminating proxy (Caddy in production) is the only public listener. The API
publishes its port on loopback and serves both `/api` and the SPA, so there is no
separate web/nginx container. The API and the worker share one image but run as
separate containers: the API must stay responsive while an execution runs, and the
worker must be restartable and scalable with more replicas or a higher
`WORKER_CONCURRENCY` (parallel executions per worker process).

## Data model

`tasks` owns each task definition and schedule. Administrator-managed system settings
retain the product's per-user concurrency and daily execution quotas. Legacy per-run
agent bounds are fixed in code; OpenCode's V2 spike currently configures a fixed step
cap, but is not yet the worker execution backend. `executions` is the durable record
of one occurrence — status, report, usage, duration, cancellation flag, worker lease.
`execution_steps` holds one row per tool call, `execution_sources` the deduplicated
sources. `provider_credentials` stores AES-GCM ciphertext with `owner_id NULL` for
administrator-managed credentials.

The unique index `(task_id, scheduled_for)` is the exactly-once-per-occurrence guard;
`NULL` scheduled_for marks manual runs, which may repeat freely.

## Scheduling

`pg-boss` owns the cron entry points (`scheduler-tick` every minute,
`scheduler-recovery` every two minutes) and the delivery of `execution-run` jobs.
A tick runs in one transaction:

```sql
select ... from tasks
where enabled and next_run_at <= now()
order by next_run_at
limit 25
for update skip locked;
```

For every row it computes the next occurrence (timezone-aware), inserts the
execution (`on conflict do nothing`) and moves `next_run_at` in the same transaction.
A crash cannot double-book: either both writes commit or neither does.

Execution is **at-least-once**: `claimExecution` flips `queued → running` with a
lease, `recoverStaleExecutions` requeues an expired lease or closes it as cancelled.
Handlers therefore re-check state before external effects.

## Timezones

All timestamps are `timestamptz` in UTC. The schedule stores an IANA zone and the
local wall clock. `cron-parser` computes occurrences in that zone:
a nonexistent local time (spring forward) moves forward inside the new offset, an
ambiguous local time (fall back) is booked once at the first instant.

## Agent loop

```
system prompt + user prompt
        │
        ▼
  provider.chat(tools) ── tool calls ──► validate → execute → observation
        │                                            │
        └──────────── final answer ◄─────────────────┘
```

The legacy loop uses fixed internal bounds for steps, tool calls, page visits, search
queries, output bytes and wall clock; administrators and task owners cannot tune them.
The OpenCode V2 container is a separate spike, not wired into task execution. Its
configured agent has a fixed step cap and deny-by-default permissions; V2 does not
provide equivalent per-session hard limits for the other budgets. Product quotas are
reserved atomically per owner when a worker claims an execution. Tool results in the
legacy loop enter context as untrusted data; there is no generic HTTP, shell or code
tool in that runtime.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| Provider unreachable / 5xx / 429 / timeout | requeue with backoff, up to 3 attempts, then `failed` with a redacted message |
| Provider 401/402/403 or another 4xx (except 429) | `failed` immediately with the redacted status and body excerpt |
| Page blocked by policy | tool returns an error step, the agent continues without that source |
| Worker crash | lease expires, recovery requeues (at-least-once) |
| Cancellation | API sets `cancel_requested`, worker polls every 2 s and aborts |
| Timeout | abort at `maxDurationSec`, status `timed_out` |
| Per-user concurrency / daily quota | atomically checked at worker admission; job delayed, then failed when attempts are exhausted |
