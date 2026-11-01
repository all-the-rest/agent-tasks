# Architecture

Agent Tasks is a small set of containers around one PostgreSQL database. There is no
separate message broker, no cache server and no Kubernetes: pg-boss stores jobs in the
same database that stores tasks, so a backup restores both.

```
                 ┌──────────────────────────────┐
  browser ──────►│ Caddy (TLS)                  │
                 └──────────────┬───────────────┘
                                │ loopback HTTP
                 ┌──────────────▼───────────────┐
                 │ api (Fastify 5)              │
                 │ API + built SPA              │
                 │ Better Auth · RBAC · audit   │
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │ postgres 17                  │
                 │ app tables + pg-boss schema  │
                 └──────────────┬───────────────┘
                                │ jobs
                 ┌──────────────▼───────────────┐
                 │ worker (agent loop)          │
                 └──────────────┬───────────────┘
                                │ token-authenticated HTTP
                 ┌──────────────▼───────────────┐
                 │ browser-runner (Chromium)    │
                 │ + enforcing egress proxy     │────► Internet
                 └──────────────────────────────┘
```

## Packages

| Package | Responsibility |
| --- | --- |
| `shared` | Zod schemas, schedule math, address/URL policy, errors, report helpers |
| `database` | Drizzle schema, generated SQL migrations, pool factory |
| `ai-providers` | OpenAI-compatible, Codex and legacy Ollama adapters; AES-GCM secret box |
| `agent-runtime` | Ten tool definitions, prompt policy, bounded agent loop |
| `browser-tools` | Runner client, SearXNG client, action schemas |
| `mock-openai` | deterministic OpenAI-compatible HTTP endpoint for tests |

## Model access

Production inference goes through an OpenAI-compatible endpoint (OpenCode Go, the
official OpenAI API or a self-hosted gateway). The adapter identifies each request
with the deployment's `User-Agent`, a per-attempt `x-opencode-session` id and the
decrypted provider key; keys live AES-256-GCM encrypted in `provider_credentials`,
not in environment variables. There is no built-in vendor default: the provider
record carries the base URL.

The Ollama adapter remains in `packages/ai-providers` for local development and is
not part of the production deployment. See
[`docs/architecture/providers.md`](docs/architecture/providers.md).

## Request path of a scheduled task

1. `scheduler-tick` (pg-boss cron, every minute) selects due tasks with
   `FOR UPDATE SKIP LOCKED`, computes the next occurrence in the task's timezone,
   inserts an `executions` row (`on conflict (task_id, scheduled_for) do nothing`)
   and moves `next_run_at` — all in one transaction.
2. The tick enqueues `execution-run` for each new execution.
3. A worker claims the execution (`queued → running`, lease), checks quotas, opens a
   browser session when the task allows web research and runs the agent loop.
4. Each tool call is validated, executed and stored in `execution_steps`; pages that
   are opened contribute sources.
5. The final Markdown, sources, uncertainty notes and usage are written to
   `executions`; the browser session is closed.

## Persistent memory

`memories` stores both `global` (one user, all of that user's tasks) and `task`
(one task) records with scope, category, stable key, origin/provenance,
`user_edited`, revision and timestamps. `memory_revisions`,
`memory_tombstones`, `memory_suggestions`, `memory_changes`, `recommendations`
and `recommendation_events` support versioning, review, recommendation history
and deletion protection. The worker loads a budgeted context fresh for every run,
so a deleted or edited record cannot come back from a cache or a prior report.
The agent exposes only `record_task_memory` and `track_recommendation`; both
validate a structured schema and are applied after a successful execution in one
transaction. Global memory is user-only. Details:
[`docs/memory.md`](docs/memory.md).

## Why these choices

- **Postgres for jobs** — one store, transactional booking, no extra service to
  operate; pg-boss provides retries, cron, singleton keys and expiry.
- **Separate worker** — an execution may take minutes; the API must stay responsive,
  and workers can be restarted or scaled as separate containers.
- **Separate browser service** — Chromium is the most exposed component; keeping it
  away from database credentials and user secrets limits the blast radius.
- **Two-layer SSRF defence** — the tool layer gives fast, explainable errors; the
  proxy is the actual network boundary.
- **At-least-once execution** — promised honestly instead of pretending exactly-once
  semantics for external effects; the occurrence index prevents double booking.

## Timezones and DST

Occurrences are computed with `cron-parser` in the task's IANA zone. A wall-clock time
that does not exist (spring forward) moves into the new offset on the same day; a time
that exists twice (fall back) is booked once at the first instant. Both cases have
fixed-instant tests in `packages/shared/test/schedule.test.ts`.

## Related documents

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — data model, failure handling
- [`docs/architecture/providers.md`](docs/architecture/providers.md) — provider contract, OpenCode Go headers
- [`docs/security/browser-isolation.md`](docs/security/browser-isolation.md) — container and egress details
- [`SECURITY.md`](SECURITY.md) — threat model
