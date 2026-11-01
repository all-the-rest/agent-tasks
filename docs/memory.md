# Persistent memory

Agent Tasks keeps two deliberately separate memory scopes in PostgreSQL. Memory
survives executions, worker restarts and application restarts; it is never stored
in a model conversation, a browser cache or a process-level cache.

| Scope | Owner | Available to | Typical content |
| --- | --- | --- | --- |
| `global` | one user | every task of that user | instructions, preferences, interests, constraints, reusable facts |
| `task` | one user + one task | exactly that task | findings, decisions, progress, open questions, next actions, recommendations |

`global` memory is **never** visible to another user and is **never** written by
the agent. Task-specific instructions (task prompt and system instructions) take
precedence over conflicting global preferences. Neither can override the system
security rules.

## Slash commands

Commands are parsed by application code (`packages/shared/src/memory.ts`), not by
an LLM, and are executed by the API with the same owner checks as every other
memory route. They therefore work across browser sessions and devices.

| Command | Effect |
| --- | --- |
| `/learn <text>` | create global memory (default scope) |
| `/learn global <text>` | create explicit global memory |
| `/learn task <text>` | create memory for the current task; rejected without a task |
| `/learn` with a similar existing memory | returns the candidates and offers an explicit update instead of creating a duplicate |
| `/memory` | list global memory plus task memory when a task is selected; every item includes its stable UUID |
| `/memory global` | list global memory |
| `/memory task` | list the current task's memory; rejected without a task |
| `/update <id> <text>` | replace the content of one memory (its revision increases) |
| `/forget <id>` | ask for confirmation, then permanently delete one memory |
| `/forget <search>` | search and return candidates; nothing is deleted until one is selected and confirmed |
| `/forget global <id>` / `/forget task <id>` | scope-checked deletion |

`/forget` with a search that matches more than one memory returns the candidates
and deletes nothing until one is selected and confirmed. `/update` accepts an
exact UUID or a unique ID prefix; an ambiguous prefix returns the candidates.

## Management UI

- **Memory** page: global memory list, search, category filter, manual create,
  edit, delete, delete-all (with explicit confirmation), export, stable IDs,
  provenance, origin, revision and timestamps.
- **Task detail → Memory** tab: task memory, the slash-command bar, automatic
  suggestions, the change journal, and the per-task learning policy.
- **Task detail → Recommendations** tab: recommendation history and status.
- **Execution detail → Memory** tab: changes and recommendations touched by that
  execution.

Deletion is user-initiated. There is no expiry, TTL or silent pruning of current
memories. Deleting a task deletes its task memory and recommendations through
`ON DELETE CASCADE`; the UI confirmation says so.

## Automatic task learning

Each task has `memory_settings`:

```json
{ "mode": "auto", "contextBytes": 12000 }
```

- `off` – no memory context, no memory tools, no recommendation updates.
- `suggest` – validated task-memory operations become pending suggestions that
  the user accepts or rejects; recommendation tracking is still recorded.
- `auto` – validated operations are applied after a successful execution and are
  listed in the change journal.

The agent can only call two structured tools: `record_task_memory` and
`track_recommendation`. They validate a fixed schema, reject credentials, cap the
number of operations and never address a database table directly. The worker
persists them **after** the execution is marked `completed`, in one transaction.
A learning failure never turns a successful execution into a failure.

Global memory changes always require an explicit user action (`/learn`, the
Memory page, or an API call with the user's session). Web content, task memory or
a generated summary can never write global memory.

### Context budgets

`contextBytes` limits the combined global + task + recommendation block. The
builder always includes global `instruction` and `constraint` records in full; if
they alone exceed the budget it includes them anyway and states the overflow
explicitly. Other records are ordered by category priority (task next actions and
open questions first) and omitted records are reported with an explicit
`memory context truncated` note. Nothing is silently dropped.

## Recommendations

Recommendations are stored per task with a stable key (`task_id, semantic_key`),
title, description, source URL, status, metadata, first/last observed and
last/status-changed timestamps. Source URLs must use `http` or `https`.
Statuses: `discovered`, `recommended`, `accepted`, `rejected`, `completed`,
`unavailable`.

The agent may set only `discovered`, `recommended` or `unavailable`. `accepted`,
`rejected` and `completed` are user decisions and are never overwritten by later
runs. Repeated observation updates `last_observed_at`; only a real title,
description, source, metadata or status change emits a `changed` event and
updates `last_changed_at`. An unchanged item is not proposed as new again.

## Versioning, deletion and non-resurrection

- Every memory has a UUID, scope, category, origin/provenance, `user_edited`
  flag, revision counter and a bounded revision history (last 20 snapshots).
- Deletion is physical. `memory_revisions` cascade; the change journal is
  sanitised (no before/after content); audit entries contain only ids, scope and
  category. Content-free `memory_tombstones` rows store the semantic key and
  SHA-256 hashes for the current text and every retained revision of the forgotten
  memory. Linked suggestion rows are scrubbed to `[deleted]`, so the text cannot
  reappear through the review queue or the execution memory tab.
- The worker reads memory fresh for every execution. A deleted memory is absent
  from search (PostgreSQL full-text index and `ILIKE`), prompts, exports and
  later runs. It is never reconstructed from execution reports or `execution_steps`.
- Automatic learning refuses to recreate a content/hash or semantic key covered
  by a tombstone. It also refuses to overwrite a memory with `user_edited = true`
  in `auto` mode; in `suggest` mode it creates a proposal that needs explicit
  approval.
- Re-creating a memory through an explicit user action is allowed; the tombstone
  only blocks automatic resurrection.

### Execution history and backups

Execution reports, steps and sources are a separate append-only history. Deleting
a memory does **not** rewrite historical reports that may already contain the old
text; this is deliberate so an execution report remains an accurate record. Those
reports are never used as a source for automatic memory. Database backups are
also separate: a restored backup can contain memories that were deleted
afterwards. Backup retention and restore policy is an operator decision; the
tombstone table protects the live database, not an old backup. Export
(`GET /api/memory/export`) includes current memories, recommendations and
content-free deletion markers.

## Database tables

| Table | Purpose |
| --- | --- |
| `memories` | current global/task records |
| `memory_revisions` | bounded content history |
| `memory_tombstones` | content-free deletion markers blocking auto-restoration |
| `memory_suggestions` | pending/accepted/rejected automatic task-memory changes |
| `memory_changes` | user-visible change journal; deletion content is removed |
| `recommendations` | deduplicated recommendation tracking |
| `recommendation_events` | created/changed/observed/status events |

PostgreSQL full-text search (`simple` configuration, useful for mixed
English/German content) is the initial retrieval mechanism. Vector search is not
enabled: it would add an external service and is not justified for the current
record counts. The schema, budgets and retrieval function are isolated so a
vector column can be added later without changing the API.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/memory?scope=&taskId=&q=&category=` | owner-scoped list/search |
| POST | `/api/memory` | manual create |
| GET | `/api/memory/:id` | read one |
| GET | `/api/memory/:id/revisions` | revision history |
| PATCH | `/api/memory/:id` | content/category/key update |
| DELETE | `/api/memory/:id` | permanent deletion |
| POST | `/api/memory/delete-all` | confirmed scope deletion |
| GET | `/api/memory/export` | JSON export |
| POST | `/api/memory/commands` | deterministic slash-command execution |
| GET | `/api/tasks/:id/memory-changes` | change journal |
| GET | `/api/tasks/:id/memory-suggestions` | review queue |
| POST | `/api/memory-suggestions/:id/accept\|reject` | review a suggestion |
| GET | `/api/tasks/:id/recommendations` | recommendation list |
| PATCH | `/api/recommendations/:id` | user status decision |
| GET | `/api/tasks/:id/recommendation-events` | recommendation history |
| GET | `/api/executions/:id/memory` | changes from one execution |

## Limitations

- Revision history is bounded to 20 snapshots per memory to avoid unbounded
  growth; the current record and the change journal are not pruned.
- Up to 1,000 memories are allowed per scope; creating more is refused until the
  user deletes something. There is no automatic eviction.
- Full-text search uses the `simple` dictionary (no stemming). Very short terms
  are matched with `ILIKE`; vector/semantic search is intentionally absent.
- Historical execution reports and database backups are not rewritten when a
  memory is deleted. See “Execution history and backups”.
- The learning tools run only after a successful model answer. A run that ends at
  the step limit is treated as unsuccessful for memory purposes.
