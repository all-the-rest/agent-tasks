# 15 — Persistent memory

**Status:** implemented

## Goal

Give each user a durable, editable global memory and each task a durable task
memory. Both survive executions and restarts, are strictly owner-scoped, and are
loaded into the agent context on every run without letting retrieved web content
or automatic summaries become user instructions.

## Scopes and isolation

- Global memory: one namespace per user, loaded for all tasks of that user,
  never visible to another user.
- Task memory: one namespace per task, loaded only for that task and its owner.
- Task-specific instructions take precedence over global preferences; security
  rules take precedence over both.
- Every API read/write/delete is owner-scoped; a task id in a request is checked
  against the authenticated user.

## Slash commands

Application code parses and executes `/learn`, `/learn global`, `/learn task`,
`/memory`, `/memory global`, `/memory task`, `/update <id> <text>`, `/forget
<id>`, `/forget <search>`, `/forget global <id>` and `/forget task <id>`.
`/learn` detects similar memories and offers an update rather than creating a
duplicate. Ambiguous ids/searches return candidates; deletion requires an
explicit confirmation. Task-scoped commands are rejected clearly when no task is
selected.

## Management

The Memory page and the task Memory tab provide list/search/filter, create, edit,
delete, export, stable IDs, origin, timestamps, revisions, automatic suggestions,
the change journal and recommendation history/status. There is no automatic
expiry. Deletion is permanent and removes the record from search, prompts,
exports and future runs. Task deletion cascades to task memory and
recommendations with a clear UI confirmation.

## Automatic learning

Per-task `memory_settings.mode` is `off`, `suggest` or `auto`, with a
`contextBytes` budget. After a successful execution, the worker applies only
schema-validated `record_task_memory` and `track_recommendation` operations in a
transaction. Global memory is never written automatically. User-edited memories
are protected from automatic overwrite; tombstones block recreation of deleted
memories; secrets are rejected.

## Recommendations

Stable key + title + description + source URL + first/last observed timestamps +
status + metadata + task. Agent statuses are limited to discovered, recommended
and unavailable; accepted, rejected and completed are user decisions. Unchanged
observations do not create a “new” recommendation.

## Persistence and security

PostgreSQL tables `memories`, `memory_revisions`, `memory_tombstones`,
`memory_suggestions`, `memory_changes`, `recommendations` and
`recommendation_events`; Drizzle migration `0003`. Full-text search with a GIN
index plus `ILIKE`; no vector database. Bounded revisions and a per-scope cap.
Credentials are rejected by a secret scanner. All content is plain text and is
rendered through the existing sanitised Markdown path. Deletion leaves no
plaintext in the audit log, change journal or suggestion queue, and content-free
tombstones hashing the current text and every retained revision block automatic
reconstruction.

## Evidence

- `packages/shared/test/memory.test.ts` — parser, duplicate detection, secret
  guard, budget and precedence.
- `packages/agent-runtime/test/memory-tools.test.ts` — structured tools, tool
  status restrictions, prompt ordering.
- `test/integration/memory.test.ts` — CRUD, cross-session, multi-user and
  cross-task isolation, duplicate/update/forget flows, scoped deletion, secrets,
  concurrency, suggestions, recommendation decisions, cascade delete, migration
  idempotence and fresh-connection persistence.
- `test/integration/memory-execution.test.ts` — real executions against the mock
  model: first run learns, second run receives prior memory, edited memory wins,
  deletion is not resurrected, recommendations deduplicate, `off` disables
  learning.
- `e2e/agent-tasks.spec.ts` — browser scenario for `/learn`, two runs, tracked
  recommendation reuse, edit, delete and changed behaviour on the next run.
