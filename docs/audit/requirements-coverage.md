# Requirements coverage audit

**Scope:** the open issues 02–14 and their requirements in `docs/requirements/02..14`
(103 acceptance criteria). Document 01 is retained because it carries the repository,
CI and catalog context; together the table covers **111** criteria.
**Snapshot:** 2026-11-09, working tree after the scoped issue #8, #20, and #32
implementation and review corrections. This rolling audit is not a release
statement. Current verification outcomes are in `docs/VERIFICATION_REPORT.md`;
the dated run below is retained as historical evidence.
Production deployment and real-provider verification are intentionally excluded.
**CI boundary:** CI run `41742072347` covered parent commit `18725fb` only. It predates
the implementation batch and review corrections, so it cannot be cited as verification
of this tree.
**Auditor stance:** requirements and verification reports are claims, not evidence.
Entries below cite current source, tests, or the reported local runs; historical
findings are labelled as such and may describe code that no longer exists.

## Legend

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED` | The code exists and does what the criterion says; a test exercises the behaviour where the behaviour is runtime-dependent. |
| `PARTIAL` | Code exists but a stated property is missing or is not true in every path. The gap is named. |
| `MISSING` | No code implements it. |
| `UNPROVEN` | Code exists, but no test in `test/`, `packages/*/test/`, `apps/*/test/`, `services/*/test/` or `e2e/` exercises it (or the only test is an `it.fails` that asserts the bug). |

## Pre-review local verification — 2026-11-04

The following results were recorded by the prior local run before independent review
corrections. They are historical evidence for that implementation snapshot, not a
claim that the post-review corrections have passed the same full suites or production
verification. See the dated post-review gates below.

```
pnpm install --frozen-lockfile         -> passed
pnpm lint                              -> passed
pnpm -r typecheck                      -> passed (10 workspace projects)
pnpm test:unit                         -> 568 passed, 4 skipped (41 files passed, 1 skipped)
pnpm --filter @agent-tasks/web test    -> 101 passed (19 files)
TEST_DATABASE_URL=postgres://agent:agent@dind:32769/agent_tasks pnpm test:integration
                                       -> 148 passed (19 files; isolated PostgreSQL)
packages/shared/test/report.test.ts    -> 8 passed after final report-link edit
docker compose ... config -q           -> passed for local and production files with synthetic secrets
isolated Compose start + /api/healthz  -> services healthy; {"ok":true}; fake runtime/provider
pnpm exec playwright test             -> 11 passed against the isolated Compose API (50.5 s)
pnpm test:contrast                     -> 2 passed (WCAG AA semantic-color matrix, light + dark)
pnpm test:screenshots                  -> 52 passed, 52 skipped (desktop/mobile review captures)
ratchet check                          -> 11/11 gates passed
git diff --check                       -> passed
```

The tests exercise report provenance checks, including current and historical
comparison rendering and remote-image suppression. The local Compose, Playwright,
contrast and screenshot results were against a test-only fake runtime/provider.
Production deployment and real-provider checks were excluded. CI run `41742072347`
passed for parent `18725fb`; it is historical evidence only.

## Earlier post-review verification — 2026-11-04 (superseded below)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed after dependency placement correction |
| `pnpm lint` / `pnpm -r typecheck` | passed |
| `pnpm test:unit` | **571 passed, 4 skipped** (41 passed files, 1 skipped) |
| `pnpm --filter @agent-tasks/web test` | **101 passed** (19 files) |
| Full integration suite | **151 passed** before the last Auth spoofed-header assertion was added |
| Targeted Auth/Admin/Provider suite | **41 passed** before that assertion |
| Final Auth rerun | blocked by PostgreSQL connection timeout before tests; the new assertion is unverified |
| `git diff --check` | passed |
| Ratchet `dependency-count` | passed, **17 ≤ 17** |
| Full Ratchet | passed, **11/11 gates**, after separating gate paths into gate-only commit `8529406` |
| Compose config/parity/deploy contract/offline deploy dry-run | passed |
| Post-review Compose E2E | not verified: the isolated build was cancelled after npm registry download timeouts; Docker CLI and database probes still time out |

## Issue #20 v1 — separate from the 02–14 criteria tally

The task destination is a per-task `standalone` / `conversation` setting, not an
OpenCode Web or separate chat integration. Private history is read from the
owner-scoped execution history. Follow-ups become manual executions, preserve
the schedule, and are blocked for paused/completed tasks or while an execution is
active. `executions.input_snapshot` freezes each run's user input; retries retain
it. Context uses up to four recent completed turns from the same task, with an
8 KB per-turn / 24 KB serialized cap and an untrusted-data label. Migration
`0010_woozy_mauler.sql` best-effort backfills older executions from the task prompt
as it exists at migration time.

The acceptance and privacy tests are in `test/integration/tasks.test.ts`,
`apps/worker/test/conversation-context.test.ts`,
`packages/agent-runtime/test/conversation-prompt.test.ts`, and the task/detail
web tests. Current verification outcomes are recorded below; the integration
gate requires PostgreSQL and is not covered by a typecheck.

The per-task concurrency guard now keeps a due occurrence pending while a task has a
queued/running execution and defers a racing worker claim without spending a retry
attempt. Regression coverage was added to `test/integration/scheduler.test.ts` and
`apps/worker/test/executor.test.ts`; the focused integration run did not reach test
bodies on the first attempt because `createHarness` timed out in `beforeAll` (20
skipped). A retry with a 120-second hook timeout passed **20/20** scheduler integration
tests in 6.73 seconds, including queued/running suppression, deferred claims, per-user
concurrency and quota; the adjacent execution-budget integration suite passed **10/10**.
The initial timeout's cause is unknown.

### Historical verification — 2026-11-05 working tree

| Gate | Result |
| --- | --- |
| `pnpm -r --workspace-concurrency=1 typecheck` | Passed across all 10 workspace projects. |
| `pnpm lint` | Passed. |
| `pnpm build` | Passed across workspace packages, apps and services; generated both 795-message locale catalogues. Vite reports a 916.48 kB minified JavaScript chunk (260.12 kB gzip), above its 500 kB advisory threshold. |
| `pnpm test:unit` | **600 passed, 4 skipped** (45 files passed, 1 skipped). |
| `pnpm --filter @agent-tasks/web test` | **171 passed** (28 files), including interactive-role accessible-name, feedback, keyboard, loading/error/empty/filled-state, retry and unsafe-source-link handling across public and authenticated routes. |
| `E2E_BASE_URL=http://127.0.0.1:5185 pnpm test:contrast` | **2 passed** (light/dark WCAG AA semantic-color matrix) against the local Agent Tasks Vite dev server. |
| Focused browser-runner policy tests | **49 passed** across egress, parser/cache and navigation-policy files, including the DNS-timeout regression; a fresh robots-policy subset rerun passed **13/13** across `robots-policy.test.ts` and `browser-robots-policy.test.ts`. |
| `packages/shared/test/report.test.ts` | **11 passed**, including hostile Markdown metadata/link and credential-bearing citation regressions for report export. |
| Ratchet 0.6.3 | **11/11 gates passed**. |
| `git diff --check` | Passed after the latest source and documentation changes. |
| Integration tests | Full suite: **161 passed** (19 files), including duplicate-invitation and hostile Markdown export regressions, owner/concurrency API tests, and migrations. Other databases were untouched. |
| Per-task concurrency delta | Focused worker executor tests passed **19/19**, scheduler integration passed **20/20**, execution-budget integration passed **10/10**, and `@agent-tasks/worker` typecheck, targeted ESLint, `git diff --check`, and Ratchet **11/11** passed. |
| Authentication rate-limit delta | `auth.test.ts` **26/26 passed**; targeted ESLint and `git diff --check` passed; Ratchet **11/11** passed. New tests assert the configured TOTP, password-reset and public sign-up limits; existing tests cover failed sign-in and verification resend. |
| Compose / E2E | Then-current `agent-tasks-e2e-review` project with `mail` and `search` profiles: **11/11 passed** (49.8 s) using only the test mock provider and fake runtime. API, PostgreSQL, runner, fake provisioner, Mailpit and SpamAssassin health checks passed; API health returned 200. Earlier 8/11 and 7/11 runs were superseded. Scoped `down --volumes --remove-orphans` completed; subsequent container, network and volume queries by project label were empty. Production deployment and live-provider checks were excluded. |
| Screenshot and DOM accessibility audit | Full current-tree route/state matrix: **52 passed, 52 intentional viewport skips** against local API/Vite with the test-only fake runtime/provider. Before each capture, checks enforce one main landmark, one named visible h1, names for visible interactive controls, image alt attributes, non-empty live announcements, and no focusable controls in aria-hidden content. The 144 full-page/section captures were reviewed; affected screens were recaptured and rechecked. |

## Summary

| Metric | Count |
| --- | ---: |
| Acceptance criteria | **111** |
| `IMPLEMENTED` | **110** |
| `PARTIAL` | **1** |
| `MISSING` | **0** |
| `UNPROVEN` | **0** |

Per document:

| Doc | Criteria | Implemented | Partial | Missing | Unproven |
| --- | ---: | ---: | ---: | ---: | ---: |
| 01 repository & CI | 8 | 8 | 0 | 0 | 0 |
| 02 authentication & roles | 10 | 10 | 0 | 0 | 0 |
| 03 multi-user isolation | 6 | 6 | 0 | 0 | 0 |
| 04 tasks & timezones | 7 | 7 | 0 | 0 | 0 |
| 05 durable scheduling | 9 | 9 | 0 | 0 | 0 |
| 06 AI providers | 8 | 8 | 0 | 0 | 0 |
| 07 Codex adapter | 5 | 5 | 0 | 0 | 0 |
| 08 agent runtime | 7 | 6 | 1 | 0 | 0 |
| 09 web research | 7 | 7 | 0 | 0 | 0 |
| 10 browser isolation & egress | 8 | 8 | 0 | 0 | 0 |
| 11 prompt injection & XSS | 8 | 8 | 0 | 0 | 0 |
| 12 reports & exports | 5 | 5 | 0 | 0 | 0 |
| 13 web UI | 6 | 6 | 0 | 0 | 0 |
| 14 deployment | 17 | 17 | 0 | 0 | 0 |

## Criteria with current gaps

These are the criteria not fully green. Checked `[x]` rows below still have a
named gap.
Resolved mismatches are recorded in the Findings section with the evidence that
closed them.

| Doc | Criterion | Audit |
| --- | --- | --- |
| 08 | Final answer stored with summary, sources and uncertainty | PARTIAL — the report stores all fields and adds uncertainty for removed unverified links, but the isolated OpenCode runner does not extract a structured uncertainty statement from the model's final text. |

**Closed mismatches (historical):** 01 shared dependency catalog; 02 single-use
invitations, TOTP/backup-code UI, email verification and audit-log coverage; 04/08
administrator-configured execution budgets; 05 per-user admission, execution
timeouts and graceful shutdown; 07 Codex config round-trip/per-user claim (closed by
refusal); 08 `fill_form` offering; 09 search backend tests; 10 sandbox and
redirect-hop proof; 11 provider-header secret redaction; 12 tool-call timeline,
export, no-invented-links and historical comparison; 14 Watchtower scope. See
Findings for the evidence and the exact boundary of each closure.

---

## 01 — Repository, license, workspace and CI

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | pnpm workspace with the claimed layout | IMPLEMENTED | `pnpm-workspace.yaml:1-4`; `apps/{web,api,worker}`, `services/browser-runner`, six packages | structural |
| 2 | Shared versions through a pnpm catalog | IMPLEMENTED | `pnpm-workspace.yaml:10-20` contains the shared catalog; workspace packages use `catalog:` for shared `drizzle-orm` and `pg-boss` versions | `pnpm install --frozen-lockfile` |
| 3 | Apache-2.0 license, README, CHANGELOG, CONTRIBUTING | IMPLEMENTED | `LICENSE` (Apache-2.0 full text), `package.json` `license: Apache-2.0`, README links it | n/a (file) |
| 4 | Strict TypeScript, typecheck every project | IMPLEMENTED | `tsconfig.base.json:5-13` (`strict`, `noUncheckedIndexedAccess`); 10 workspace projects have `typecheck` | `pnpm -r typecheck` passed |
| 5 | ESLint flat config | IMPLEMENTED | `eslint.config.js` | `pnpm lint` passed |
| 6 | CI: lint, typecheck, unit, integration (Postgres), E2E, image build, Trivy, gitleaks | IMPLEMENTED | `.github/workflows/ci.yml` jobs `lint-typecheck`, `unit`, `integration` (Postgres service), `e2e`, `docker`, `security`; the deployment checks (compose config, ShellCheck, dry-run, parity) run in `lint-typecheck` | CI run `41742072347` passed for parent `18725fb` only; current `HEAD` and the working tree are not covered |
| 7 | Repo-local hooks: secret scan, ratchet, lint, typecheck, codegraph | IMPLEMENTED | `.githooks/pre-commit:6-33`; `core.hooksPath=.githooks` | hook script |
| 8 | Ratchet gates with a committed baseline | IMPLEMENTED | `ratchet.config.jsonc`, tracked `ratchet.baseline.json`; pinned Ratchet `0.6.3` | `ratchet check`: 11/11 passed |

## 02 — Authentication, roles and account lifecycle

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Email/password, minimum length 12 | IMPLEMENTED | `apps/api/src/auth.ts` (`minPasswordLength: 12`); `routes/setup.ts` rejects a shorter setup password | setup path covered; no explicit 11-character login test |
| 2 | Registration closed; single-use 7-day invitations | IMPLEMENTED | `setup.ts` `claimInvitation` is a single `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`; `app.ts` claims and releases the same invitation for the sign-up bridge; expiry is enforced in the claim | `auth.test.ts` concurrent accept (one 200, one 404), expired/reused invite, bridge consumption |
| 3 | First admin via `SETUP_TOKEN`, refused afterwards | IMPLEMENTED | `setup.ts` transaction-scoped advisory lock, admin count and insert; the setup account is created through Better Auth and compensated on failure | `auth.test.ts` single admin, second setup, concurrent double submit |
| 4 | Session revocation on next request | IMPLEMENTED | `auth.ts` (`cookieCache.enabled=false`); `lib/session.ts` reads DB each request | `auth.test.ts` logout/session assertions |
| 5 | TOTP MFA with backup codes, verified before activation | IMPLEMENTED | `auth.ts` twoFactor plugin (`skipVerificationOnEnable: false`); `LoginPage.tsx` has a TOTP/backup-code step; `SettingsPage.tsx` enables, shows the URI and backup codes, and requires a code to disable | `auth.test.ts` TOTP enable/sign-in; `apps/web/test/login-mfa.test.tsx` (4), `settings-mfa.test.tsx` (2) |
| 6 | Rate limits on sign-in, TOTP, reset, sign-up | IMPLEMENTED | `auth.ts` custom rules for sign-in, get-session, TOTP, reset, verification resend and sign-up | `auth.test.ts` asserts 429 boundaries for failed sign-in, TOTP verification, reset requests, verification resends and public sign-up |
| 7 | Password reset + email verification via SMTP (log in dev) | IMPLEMENTED | `mailer.ts`; public signups require verification; trusted setup/invitation signups suppress redundant mail and are marked verified; production open registration requires SMTP | `auth.test.ts`; post-review integration gates below |
| 8 | Admin-only user management, last-admin guard | IMPLEMENTED | `routes/admin.ts` advisory-lock transaction re-reads target and active-admin count | `isolation.test.ts` last-admin; `admin.test.ts` audit/invariants |
| 9 | Audit log for every sensitive admin op | IMPLEMENTED | `context.audit`; `AUDIT_ACTIONS` covers setup, invite, role/ban, settings, provider/credential and task/share/memory operations. The Better Auth admin plugin is no longer mounted, so its unaudited endpoints do not exist | `test/integration/audit.test.ts` asserts setup/invite/role/disable/enable/settings/provider/credential rows and that the key never appears (1 passed in the targeted run); `admin.test.ts` |
| 10 | CSRF: Better Auth origin + explicit origin guard | IMPLEMENTED | `app.ts` POST/PUT/PATCH/DELETE origin guard; `auth.ts` trusted origins and SameSite Lax | `auth.test.ts` cross-origin POST; a request without `Origin` still passes |

## 03 — Strict multi-user isolation

Route inventory rechecked across `apps/api/src/routes/*.ts` (tasks, task shares, memory,
providers, admin, setup) plus the `/api/auth/*` wildcard in `app.ts`. Private task-,
execution- and memory-scoped handlers use the session owner. Public share reads are the
explicit exception: they return only the immutable snapshot authorized by a share token.
Provider/admin queries are global only where the resource is deployment-wide.

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Private queries are owner-scoped; public share reads expose only token-authorized snapshots | IMPLEMENTED | private task/execution/memory/credential routes scope by owner; `task-shares.ts` public read is the explicit token-only snapshot exception; provider/admin queries are deployment-global by design | `isolation.test.ts`; `task-shares.test.ts` public snapshot/adoption cases |
| 2 | Client `ownerId`/`id` ignored on create | IMPLEMENTED | zod strips unknown keys; explicit insert in `tasks.ts` and `task-shares.ts` | `isolation.test.ts` forged owner id |
| 3 | Malformed ids → 404, not a DB error | IMPLEMENTED | `requireUuid` is applied to task, execution, share, provider, credential, invitation and memory uuid params; user ids are Better Auth text ids | `providers.test.ts` malformed-id matrix, task/execution tests, `admin.test.ts` |
| 4 | Admin role grants no access to user tasks/executions/credentials | IMPLEMENTED | `admin.ts` is admin-only; user reads check `ownerId`; the Better Auth admin plugin is absent and `lib/session.ts` rejects any session carrying `impersonatedBy`, including a stored marker | `isolation.test.ts` admin bypass attempts; `auth.test.ts` impersonation-marker and `/api/auth/admin/*` regressions |
| 5 | Personal credentials per-owner; shared explicit | IMPLEMENTED | `ai-providers/src/registry.ts`; `schema.ts` `provider_credentials`; routes in `providers.ts`. A shared rotation locks the provider row, updates the newest shared row and removes legacy `owner_id IS NULL` duplicates for that provider, while personal keys and other providers are untouched | `isolation.test.ts` personal credential isolation; `providers.test.ts` shared update; `credential-rotation.test.ts` legacy-duplicate and concurrent-rotation cases (2 passed, with providers + isolation 20 passed) |
| 6 | Background execution re-derives ownership from the task row | IMPLEMENTED | `executor.ts` joins the task and resolves credentials for `task.ownerId` | `execution.test.ts` |

## 04 — Task management and timezones

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | All listed task fields | IMPLEMENTED | `schema.ts:230-267`; `shared/src/schemas.ts:37-49` | `task-schema.test.ts` (form) |
| 2 | CRUD, pause/resume, run-now, duplicate, history | IMPLEMENTED | `routes/tasks.ts` (create, read, patch, delete, run, pause, resume, duplicate, history list) | create/read/patch/delete/run/pause/resume/duplicate covered in `tasks.test.ts`; history pagination in `tasks.test.ts` and `tasks-inbox.test.tsx` |
| 3 | Presets once/daily/weekdays/weekly/monthly/custom | IMPLEMENTED | `shared/src/schedule.ts:9-80` | `schedule.test.ts:18-32` |
| 4 | UTC storage, schedule in IANA zone | IMPLEMENTED | `timestamptz` columns; `nextOccurrence` `schedule.ts:94-104` | `schedule.test.ts:34-39` |
| 5 | Spring-forward gap runs at 03:30 | IMPLEMENTED | `schedule.ts:94-104` | `schedule.test.ts:41-46` (passes) |
| 6 | Fall-back runs once at the first instant | IMPLEMENTED | same | `schedule.test.ts:48-53` (passes) |
| 7 | Per-run budgets | IMPLEMENTED | `resolveAgentLimits` clamps admin settings to finite hard maxima; executor forwards step, call, page, search, output and duration limits. PostgreSQL atomically reserves call/page/search/output usage across retries and worker recovery. Production activation remains gated independently. | `execution-budget.test.ts`; worker bridge/runner tests; full integration run |

## 05 — Durable scheduling

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | pg-boss queues for tick, recovery, execution | IMPLEMENTED | `worker/src/index.ts` schedules the three queues and registers workers; `queues.ts` creates all three | indirect |
| 2 | `FOR UPDATE SKIP LOCKED` + unique occurrence | IMPLEMENTED | `scheduling.ts`; unique index on `(task_id, scheduled_for)` | `scheduler.test.ts` single booking, idempotent/concurrent ticks, duplicate rejection |
| 3 | Multiple workers safe (claim flips queued→running) | IMPLEMENTED | `scheduling.ts` claim transaction | `scheduler.test.ts` exactly one claim |
| 4 | Leases and crash recovery (requeue/cancel) | IMPLEMENTED | `scheduling.ts`; recovery sweep every 2 min | `scheduler.test.ts` stale-lease requeue/cancel |
| 5 | Retries with backoff, max 3 | IMPLEMENTED | `executor.ts` `MAX_ATTEMPTS` and `startAfter` | `execution.test.ts`; transient paths allow failed or queued |
| 6 | Execution timeouts and cancellation polling | IMPLEMENTED | the deadline aborts with reason `timeout`; cancellation polling aborts with `cancelled`; `classifyExecutionFailure` maps any pre-completion failure after an abort to `AgentCancelledError`, so a deadline is stored as `timed_out` and a cancellation as `cancelled`, neither retried. A genuine provider timeout with no abort stays retryable | `executor.test.ts` covers the reason split, classification, the retry of a genuine provider timeout, and `timed_out`/`cancelled` after abort |
| 7 | Per-user concurrency and daily quota | IMPLEMENTED AT ADMISSION | `scheduling.ts` serializes owner admission with a transaction-scoped advisory lock, checks limits before flipping the row and reserves the slot atomically | `scheduler.test.ts` concurrent slot and daily-quota admission |
| 8 | Graceful shutdown aborts running executions | IMPLEMENTED (mechanism) | `executor.abortAll()` aborts every controller and `settleWithin` waits a bounded grace; `index.ts` wires SIGTERM/SIGINT. The signal handler itself is a thin untested wrapper | `executor.test.ts` (settled, aborts, grace expiry), `lifecycle.test.ts` |
| 9 | Documented at-least-once semantics | IMPLEMENTED | `docs/architecture/overview.md`; `ARCHITECTURE.md` | doc |

## 06 — AI providers

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Ollama: discovery, capability, tools, timeouts, errors | IMPLEMENTED | `ollama.ts` tags/show/chat, typed errors, abort and timeout handling | `packages/ai-providers/test/ollama.test.ts` (15 passed in the targeted run) |
| 2 | Model without `tools` capability refused | IMPLEMENTED | `ollama.ts` fails closed: a failed or empty `/api/show` yields no `tools` and `chat` throws `unsupported` when tools are offered | `ollama.test.ts` capability-probe omission and probe-failure tests |
| 3 | OpenAI-compatible with base URL, headers, timeouts | IMPLEMENTED | `openai-compatible.ts` | `openai-compatible.test.ts` |
| 4 | Honest User-Agent + stable `x-opencode-session` | IMPLEMENTED | `openai-compatible.ts`; `runtime.ts` passes one id per run | `openai-compatible.test.ts`; mock-openai rejects generic UA/session |
| 5 | Records `opencode.allowance` | IMPLEMENTED | `openai-compatible.ts` usage mapping | `openai-compatible.test.ts` |
| 6 | Tool support declared, never assumed | IMPLEMENTED | `provider-catalog.ts` merges persisted discovery with declared overrides and accepts only `supportsTools === true`; API, executor, runner and provisioner refuse before provisioning | `provider-catalog.test.ts`; `execution.test.ts`; `test/integration/provider-catalog.test.ts` |
| 7 | `packages/mock-openai` real HTTP server enforcing the contract | IMPLEMENTED | `mock-openai/src/index.ts` | `openai-compatible.test.ts` |
| 8 | Credentials per-user/shared, never sent to the runner | IMPLEMENTED | `registry.ts`; `browser-tools/src/client.ts` sends actions only, with no credential field | `execution.test.ts` asserts only the owner-resolved key reaches the provisioner; no direct runner-payload assertion |

## 07 — Codex / ChatGPT integration

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Adapter exists, disabled by default | IMPLEMENTED | `AGENT_TASKS_ENABLE_CODEX` plus record-level `enabled`; `providers.ts` parses Codex with its own `codexConfigSchema` (no key stripping); the worker refuses the `codex` kind on every execution path | `providers.test.ts` Codex config round-trip; `provider-catalog.test.ts`/`codex-executor.test.ts` kind refusals |
| 2 | Per-user `CODEX_HOME`, no shared accounts | IMPLEMENTED BY REFUSAL | the requirement was revised to close this by refusing `codex` for task execution: no task can share an account. One deployment-global `codexHome` still exists for library health checks; there is no user → directory mapping | kind-refusal tests |
| 3 | No browser cookies, undocumented endpoints, token extraction | IMPLEMENTED | `codex.ts` only spawns `codex exec` | none |
| 4 | Text-only: refuses tool calling | IMPLEMENTED | `codex.ts` rejects tool requests | none |
| 5 | Documented limitation (Go ≠ API credit) | IMPLEMENTED | `docs/architecture/providers.md` Codex section | doc |

## 08 — Agent runtime

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Ten named tools | IMPLEMENTED | all ten tools are defined; the OpenCode runner offers `fill_form` whenever `allowWebResearch` is on (`executor.ts` passes `allowForms: task.allowWebResearch`), and the tool has no submit argument | `tools.test.ts` fill_form dispatch; `runtime.test.ts` inventory; browser runner rejects form submission |
| 2 | No shell, JS, filesystem | IMPLEMENTED | only the ten tools exist; no shell/JS/file tool is registered | `runtime.test.ts` (`run_shell` refused) |
| 3 | Every call validated + allowlist, unknown refused | IMPLEMENTED | zod per tool; runtime and MCP bridge allowlists | `runtime.test.ts`; `opencode-tool-bridge` tests |
| 4 | Global administrator-configured limits per step/tool/page/search/output/duration | IMPLEMENTED | The admin settings UI/API persists limits; `resolveAgentLimits` bounds them by hard maxima, executor enforces duration and passes the remaining budgets to the isolated runner/bridge, and PostgreSQL counters are durable across retries/recovery. Production activation remains gated independently | `admin-limits.test.tsx`; `execution-budget.test.ts`; runner/bridge tests |
| 5 | Retrieved content wrapped as untrusted | IMPLEMENTED | `prompt.ts` separates system/user/retrieved text and labels web text untrusted | `runtime.test.ts` |
| 6 | Sources collected, deduped, persisted with confidence | IMPLEMENTED | runtime/bridge collect sources; `executor.ts` persists `execution_sources` with dedupe | `execution.test.ts` real browser bridge |
| 7 | Final answer stored as Markdown + summary/sources/uncertainty | PARTIAL | `executor.ts` stores summary, Markdown, sources and uncertainty; link provenance failures add uncertainty, but the isolated OpenCode runner does not parse model uncertainty into a structured field | `execution.test.ts`; `report.test.ts` |

## 09 — Web research

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | SearXNG JSON adapter, composable interface | IMPLEMENTED | `browser-tools/src/search.ts` | `packages/browser-tools/test/search.test.ts` drives the real adapter against a local HTTP server: mapping, limits, non-HTTP filtering, status errors and abort |
| 2 | Fixture and no-op providers | IMPLEMENTED | `search.ts` deterministic providers | same file covers `FixtureSearchProvider` and `NoopSearchProvider` |
| 3 | Visited URLs, timestamps, titles, excerpts per execution | IMPLEMENTED | browser tools; `executor.ts` persists `execution_sources` | `execution.test.ts` real-page source persistence |
| 4 | Inaccessible pages reported as errors, not invented | IMPLEMENTED | tool results carry errors; report link check strips unsupported links | `execution.test.ts` blocked/loopback case |
| 5 | Domain/redirect validation in the browser layer | IMPLEMENTED | `browser.ts`, `proxy.ts`; each redirect is a new absolute-form proxy request | `net.test.ts`, `egress.test.ts` redirect-hop case |
| 6 | Enforce robots.txt for main-frame navigations; keep site ToS as operator responsibility | IMPLEMENTED | `services/browser-runner/src/robots-policy.ts` and `browser.ts` enforce per-execution robots rules for main-frame navigations, including redirects; `docs/security/browser-isolation.md` records the boundary: ToS, licensing and site-specific rate limits remain operator responsibilities | `services/browser-runner/test/robots-policy.test.ts`; `browser-robots-policy.test.ts` |
| 7 | Captcha/paywall out of scope | IMPLEMENTED | recorded decision, no code needed | n/a |

## 10 — Browser isolation and egress

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Separate service, non-root, no caps, read-only, pids/memory | IMPLEMENTED | `compose.yaml` runner service; `Dockerfile.runner` `USER pwuser` | config |
| 2 | No published port, no docker socket, no host networking | IMPLEMENTED | `compose.yaml` runner has no `ports:`/socket/host network | config |
| 3 | Chromium sandbox enabled | IMPLEMENTED (resolved 2026-10-31) | seccomp allows `unshare`/`clone(CLONE_NEWUSER)` and the zygote's `clone(CLONE_NEWPID/NEWNET)`; `CAP_SYS_CHROOT` retained. Probe run `41226712667`: `LAUNCH_OK sandbox=true` + `PAGE_OK`; CI asserts `sandbox: true` | `seccomp-profile.test.ts`, historical CI E2E |
| 4 | Fresh context, downloads off, non-http(s) aborted | IMPLEMENTED | `browser.ts` (`acceptDownloads:false`, route abort) | browser-runner suite and E2E |
| 5 | Enforcing proxy resolves, checks all answers, pins | IMPLEMENTED | `proxy.ts`, `net.ts` | `egress.test.ts` |
| 6 | Blocks loopback/RFC1918/link-local/metadata/CGNAT/multicast/reserved/IPv6/mapped/NAT64 | IMPLEMENTED | `net.ts` classification; proxy calls it | `net.test.ts`, `egress.test.ts` |
| 7 | Every redirect hop re-validated | IMPLEMENTED | each Chromium request, including redirect follow-ups, is an absolute-form proxy request, so the policy runs per hop; no per-session allowlist | `egress.test.ts` redirect hop into a private network is refused and recorded |
| 8 | Session closed after execution | IMPLEMENTED | `executor.ts` finally-block; browser client DELETE | `execution.test.ts` sessions == 0 |

## 11 — Prompt injection, XSS, CSRF, secrets

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | System/user/retrieved separated, web text untrusted | IMPLEMENTED | `prompt.ts`; `runtime.ts` | `runtime.test.ts` |
| 2 | No execution of model code/shell/unrestricted requests | IMPLEMENTED | runtime and MCP allowlists | `runtime.test.ts` |
| 3 | Login/checkout/payment/destructive clicks refused | IMPLEMENTED | `click-policy.ts` matches normalized whole-phrase English/German controls and checks HTTP(S) href/form actions, current routes, nested redirect parameters and hash routes. `BrowserPool` checks each HTTP navigation redirect hop. `inspectBrowserPolicy` checks composed ancestors/descendants, accessible names, effective GET fields, multi-select values and hidden/action-like POST fields; tracked/inline handlers fail closed across open/closed Shadow DOM, slots and lifecycle events. Live click/form fingerprints are revalidated at arming and dispatch | `click-policy.test.ts` and `browser-click-policy.test.ts` (212 browser tests in the reported run) |
| 4 | Form submission disabled by policy | IMPLEMENTED | `executor.ts` sets `allowForms` only for research; the model-facing `fill_form` has no submit argument and the runner rejects submission | `tools.test.ts`; browser runner form-submission tests |
| 5 | Markdown via `rehype-sanitize`, no raw HTML sink | IMPLEMENTED | `ExecutionDetailPage.tsx`; ratchet `no-raw-html` = 0 | `markdown-safety.test.tsx` |
| 6 | Origin guard on state-changing app routes | IMPLEMENTED | `app.ts` POST/PUT/PATCH/DELETE guard | `auth.test.ts` cross-origin POST |
| 7 | Secret redaction in logs/errors/provider messages | IMPLEMENTED | `collectKnownSecrets` includes provider credentials; `providerHeaderSecrets` adds configured header values; errors, step arguments/previews and notification failures redact the combined set | `credentials.test.ts`, `executor.test.ts`, log-redaction tests |
| 8 | Credentials never returned by an API response | IMPLEMENTED | `/api/providers` whitelists non-secret fields; `/api/admin/providers` uses `redactProviderConfig` (safe keys, header values `***`) and restores stored headers on edit | `providers.test.ts` header-secret and round-trip tests; `redactProviderConfig` unit tests |

## 12 — Reports and exports

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Metadata, tool timeline, sources, Markdown report, usage, sanitized errors | IMPLEMENTED | `executor.ts` persists bounded, redacted MCP call steps as they occur plus the terminal OpenCode summary; private memory/recommendation payloads are omitted. Durable budgets and execution details are owner-scoped | worker bridge tests; `execution-budget.test.ts`; `execution.test.ts` |
| 2 | Markdown + JSON export with `Content-Disposition` | IMPLEMENTED | `tasks.ts` export route: JSON carries metadata, duration, sanitized error, report, usage and the full step timeline; Markdown renders summary, report, sources and uncertainty; both set `Content-Disposition` and are owner-scoped | `isolation.test.ts` JSON/Markdown, headers, cross-user 404 |
| 3 | Clickable sources with timestamps and confidence | IMPLEMENTED | `ExecutionDetailPage.tsx` sources tab; `execution_sources` | `execution.test.ts` |
| 4 | No invented links: sources from tool results only | IMPLEMENTED | `checkReportLinks` strips links not produced by tool results, adds an uncertainty note, and removes all remote images to prevent tracking/content loads | `report.test.ts`, `markdown-safety.test.tsx` |
| 5 | Historical comparison in execution details, linked to the previous execution | IMPLEMENTED | Current and historical reports both re-check link provenance; `ExecutionDetailPage.tsx` fetches and renders the previous report side by side; `TaskDetailPage` lists history | `execution-detail.test.tsx` (current/historical provenance regression) |

## 13 — Web UI

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Login, setup, invite, dashboard, tasks, editor, executions, detail, settings, admin users/providers/audit/monitoring | IMPLEMENTED | `App.tsx`; one page file per route, plus the public share page | E2E covers a subset (CI only) |
| 2 | Responsive, daisyUI, Tailwind v4 | IMPLEMENTED | `apps/web/package.json` (`daisyui ^5.7.50`, `tailwindcss ^4.3.3`); classes throughout | none |
| 3 | Full en/de Lingui 6 PO catalogues, language persisted | IMPLEMENTED | `src/locales/en/messages.po` and `src/locales/de/messages.po` — 795 messages each, generated successfully with no reported gaps; `i18n/index.ts` localStorage | `i18n.test.tsx`, web build, E2E language switch |
| 4 | Accessible controls, labels, loading/error/empty states | IMPLEMENTED | Full desktop/mobile screenshot matrix covers every configured route/state; a DOM audit runs before each capture. Page-specific tests exercise loading/error/empty/filled, keyboard and recovery states, and contrast passes in light/dark themes. See `docs/requirements/13-web-ui.md` and `docs/audit/ui-review-findings.md`. | `tests/screenshots/ui-screenshots.spec.ts`; `apps/web/test/accessibility-helpers.ts`; `apps/web/test/ui-feedback-accessibility.test.tsx`; `apps/web/test/ui-field.test.tsx`; `apps/web/test/ui-dialog.test.tsx`; `apps/web/test/login-mfa.test.tsx`; `apps/web/test/verification-resend.test.tsx`; `apps/web/test/register-accessibility.test.tsx`; `apps/web/test/not-found-accessibility.test.tsx`; `apps/web/test/task-creation.test.tsx`; `apps/web/test/setup-accessibility.test.tsx`; `apps/web/test/invite-accessibility.test.tsx`; `apps/web/test/dashboard-accessibility.test.tsx`; `apps/web/test/executions-accessibility.test.tsx`; `apps/web/test/tasks-inbox.test.tsx`; `apps/web/test/detail-tabs.test.tsx`; `apps/web/test/execution-detail.test.tsx`; `apps/web/test/layout-accessibility.test.tsx`; `apps/web/test/share-page.test.tsx`; `apps/web/test/admin-accessibility.test.tsx`; `pnpm test:contrast` (2); screenshot matrix (52 captures). |
| 5 | Markdown report rendered sanitized | IMPLEMENTED | `ExecutionDetailPage.tsx` `rehypeSanitize` | `markdown-safety.test.tsx` (3) |
| 6 | E2E against the real API | IMPLEMENTED | `e2e/agent-tasks.spec.ts`; current local API/Vite and scoped Compose Playwright runs both passed **11/11** using test-only provider/runtime. CI run `41742072347` is historical for parent `18725fb` | local API/Vite Playwright (11); Compose Playwright (11); runner and service health |

## 14 — Deployment and operations

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Compose: API+SPA, worker, postgres, hardened runner | IMPLEMENTED | `compose.yaml` | config; Compose E2E in historical CI |
| 2 | Optional profiles: SearXNG, Mailpit | IMPLEMENTED | `compose.yaml` profiles `search`, `mail` | config |
| 3 | Named volumes, health checks, restart policies, no DB port | IMPLEMENTED | `compose.yaml`; postgres has no `ports:` | config |
| 4 | Pinned images, minimal privileges, seccomp | IMPLEMENTED | pinned postgres/node/Playwright images; `docker/seccomp-browser.json`; `cap_drop` on api/worker/runner | config |
| 5 | Watchtower labels for api/worker only | IMPLEMENTED | api/worker `true`; browser-runner, provisioners, mail and SearXNG `false` | config |
| 6 | README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, `.env.example` | IMPLEMENTED | all eight files exist at the root | doc |
| 7 | Production services carry `com.agent-tasks.stack=production` | IMPLEMENTED | `deployment/compose.production.yaml` anchor `x-stack-label`, applied to every service | `scripts/check-compose-parity.mjs` |
| 8 | Deploy preflight fails closed on webnet/host `.env`/override/search settings | IMPLEMENTED | `deployment/deploy.sh` preflight: exact `172.18.0.0/16` + gateway, root-only host `.env`, no implicit override or `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`, search profile settings; renders effective Compose values | `scripts/test-deploy-dry-run.sh` (offline dry-run cases) |
| 9 | `RUNNER_TOKEN` on worker + browser-runner, equal, rejected on api; project `agent-tasks` | IMPLEMENTED | `deploy.sh` renders the stack and validates token presence/equality/placement; `compose.production.yaml` uses `${RUNNER_TOKEN:?}` | `test-deploy-dry-run.sh` mutation cases |
| 10 | Remote Compose pinned to `-p agent-tasks` and `/opt/stacks/agent-tasks/compose.yaml` (`.next` candidate) | IMPLEMENTED | `deploy.sh`; staged `compose.yaml.next` promoted only after preflight | `test-deploy-dry-run.sh` checks every Compose line |
| 11 | Seccomp validated locally, staged, pinned; changed bytes recreate only browser-runner | IMPLEMENTED | `deploy.sh` validates/stages `docker/seccomp-browser.json`, sets `RUNNER_SECCOMP_PATH`, compares hashes and force-recreates only the runner | `test-deploy-dry-run.sh` unchanged/changed/symlink/invalid-JSON cases |
| 12 | Compose parity compares volume source/target/read-only, including the SearXNG host bind | IMPLEMENTED | `scripts/check-compose-parity.mjs`; documented bind handled explicitly | `scripts/test-compose-parity.mjs` offline mismatch case |
| 13 | SSH BatchMode, connect timeout, strict host-key checking | IMPLEMENTED | `deploy.sh`; `UserKnownHostsFile` and the operator's existing `known_hosts` | `test-deploy-dry-run.sh` missing known_hosts/SSH option cases |
| 14 | Pre-deploy root-only `.env` + PostgreSQL backup, documented rollback | IMPLEMENTED | `deploy.sh` backup stage (`pg_dump`, gzip validation, mode 0600) and `DEPLOYMENT.md` rollback with `psql -v ON_ERROR_STOP=1 --single-transaction` | `test-deploy-dry-run.sh` running/stopped/empty-dump paths and promote body |
| 15 | Portainer migration runbook preserves secrets, project name and volumes | IMPLEMENTED | `DEPLOYMENT.md` "Migration from Portainer (historical path)" | doc |
| 16 | CI checks compose parity, shell syntax, ShellCheck and an offline deploy test; pre-commit globs every staged path | IMPLEMENTED | `.github/workflows/ci.yml` deployment step; `.githooks/pre-commit` collects every staged file | CI `lint-typecheck` job |
| 17 | Full compose start verified in this environment | IMPLEMENTED | Current-tree `agent-tasks-e2e-verify` stack started with the `mail`/`search` profiles; API and all health-checked services were healthy, API health returned 200, and Compose Playwright passed **11/11 in 51.5 s** using the test fake provider/runtime. Project-scoped `down --remove-orphans` removed the stack containers/networks and deliberately retained its PostgreSQL volume. Production deployment excluded | isolated Compose up; service health; Playwright 11/11; scoped teardown preserving volume |

---

## Findings

Status as of 2026-11-04. “Resolved in this batch” means the fix is in the implementation
batch and its post-review corrections; CI run `41742072347` (parent `18725fb`) predates
it. Historical finding text is kept where it explains what the fix had to address.

### Critical

**C1 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04; not in CI
`41742072347`).** Historical: Better Auth's `admin()` plugin exposed
`POST /api/auth/admin/impersonate-user`, and `sessionUser` accepted the victim's
session without checking `session.impersonatedBy`, so owner-scoped queries ran as the
victim. Current: the plugin is deliberately absent from `apps/api/src/auth.ts`;
`lib/session.ts` rejects both a session-payload marker and the stored
`session.impersonated_by` column. `auth.test.ts` marks a real session row and asserts
401 on `/api/me` and `/api/tasks`, and separately asserts that
`/api/auth/admin/{set-role,impersonate-user,ban-user,create-user}` are not routed
(401/403/404). The 03 criterion and README statement now hold for this tree.

### High

**H1 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** Historical: the
admin plugin's `set-role`, `ban-user`, `remove-user`, `create-user` and
`set-user-password` endpoints bypassed the last-admin guard, wrote no audit row and
created accounts without an invitation. Current: the plugin is not mounted, so those
endpoints do not exist; `/api/admin/*` is the only administration surface, with the
advisory-locked guard, invite-only onboarding and audit writes. `auth.test.ts`
asserts the plugin endpoints no longer answer 200 while the two-factor plugin stays
mounted; `audit.test.ts` asserts the custom routes' rows.

**H2 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** Historical:
`setup.ts` did `SELECT → signUpEmail → UPDATE acceptedAt` outside a transaction, and
the sign-up bridge never consumed the invite. Current: `claimInvitation` is one
`UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING` compare-and-swap; `app.ts` claims for the bridge, releases on failure and
marks the account verified; `POST /api/setup` additionally serializes the zero-admin
check under an advisory lock. `auth.test.ts` covers concurrent accept (one 200, one
404), expiry, bridge consumption and concurrent setup; `invitation-preview.test.ts`
covers the preview state checks.

**H3 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** Historical:
`LoginPage` treated `twoFactorRedirect` as a failed login, and no MFA UI existed.
Current: `LoginPage.tsx` switches to a TOTP/backup-code step and calls
`verify-totp`/`verify-backup-code`; `SettingsPage.tsx` enables MFA, shows the TOTP URI
and backup codes, and requires a code to disable it. The plugin uses
`skipVerificationOnEnable: false`. Web tests: `login-mfa.test.tsx` (4),
`settings-mfa.test.tsx` (2); the API TOTP flow is in `auth.test.ts`.

**H4 — RESOLVED (admission path).** Admission serializes checks per owner and reserves
a running slot in the same transaction (`apps/worker/src/scheduling.ts`); concurrent
integration tests cover the execution slot and daily quota. Queued jobs still wait
when the owner is at capacity. `WORKER_CONCURRENCY` is applied to pg-boss separately
and is not part of the per-owner guarantee.

**H5 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** Historical: a
deadline abort surfaced as `ProviderError('timeout')` and was requeued.
Current: the deadline aborts with reason `timeout`, cancellation polling and shutdown
with `cancelled`; `classifyExecutionFailure` maps any pre-completion failure after the
executor's own abort to `AgentCancelledError`, so `failExecution` stores `timed_out`
or `cancelled` and does not retry. A genuine provider timeout without an abort keeps
its retryable classification. `executor.test.ts` covers both the classification and
the end-to-end `timed_out`/`cancelled` status updates.

**H6 — RESOLVED BY REFUSAL (2026-11-04; implementation batch).** Historical: all non-Ollama
kinds were parsed with `compatibleConfigSchema`, which stripped `codexHome` and
`enabled`, and one global `codexHome` would have been shared by every user. Current:
`providers.ts` parses Codex with the dedicated `codexConfigSchema` (round-trip test in
`providers.test.ts`), while requirement 07 was revised to close the account-scoping
claim by refusing the `codex` kind for all task execution. The adapter remains
library-only for admin health checks; the single deployment-global directory still
exists, but no task can use it.

**H7 — RESOLVED (2026-11-04).** The baseline is tracked, the repository has commit
history, and CI run `41742072347` passed its lint, typecheck, unit, integration, E2E,
container-image and security jobs for parent `18725fb`. That run is historical for
this tree, not current verification.

### Medium

**M1 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** `requireUuid` is now
applied to task, execution, share, provider, credential, invitation and memory uuid
params. `providers.test.ts` exercises a malformed-id matrix and gets 404, not a
database error.

**M2 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04; targeted tests
passed).** The shared-credential write locks the provider row, updates the newest
shared row and deletes the remaining legacy `owner_id IS NULL` rows for that provider
inside the same transaction. This also cleans up duplicates left by older releases,
which could otherwise keep an outdated key alive because `resolveCredential` picks
without ordering. Personal credentials (`owner_id NOT NULL`) and other providers are
never touched. `credential-rotation.test.ts` covers the legacy-duplicate and
concurrent-rotation cases (2 passed); the providers + isolation targeted run passed
20 tests.

**M3 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** `executor.ts` now
passes `allowForms: task.allowWebResearch`, and the OpenCode runner offers `fill_form`
for research tasks. The model-facing tool has no submit argument and the browser
runner still refuses form submission; `tools.test.ts` covers the dispatch.

**M4 — RESOLVED (2026-11-04).** `click-policy.ts` matches normalized whole-word
English/German sensitive phrases and checks target hrefs, effective form actions,
current routes, redirect destinations, hash routes and action-like query values.
`inspectBrowserPolicy` checks activation ancestors/descendants and accessible names
including ARIA references, native labels and image alt text. Policy and BrowserPool
dispatch tests cover click and Enter-based form submission; the reported browser suite
is 4 files / 212 tests passed.

**M5 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** `/api/admin/providers`
now returns `redactProviderConfig`: only safe keys, every header value replaced by
`***`. Editing the redacted config restores the stored header values.
`providers.test.ts` asserts a header secret is never echoed and survives a
redacted-config round trip; the non-admin `/api/providers` whitelist remains.

**M6 — OPEN, NARROWED (2026-11-04).** Two of the four admin-visible settings now have
an effect: `allowRegistration` is checked by the sign-up bridge, and
`notification: 'email'|'email_on_change'` sends a completion mail (including the
change comparison). `browserAllowHttp` and `browserAllowedPorts` are still stored and
shown in the admin UI, but the runner reads only `RUNNER_ALLOW_HTTP` /
`RUNNER_ALLOWED_PORTS`; the values are not passed from settings to the runner.
*Fix:* pass the effective settings when creating the runner session or remove the
controls.

**M7 — RESOLVED (2026-11-04).** The owner-scoped export includes execution metadata,
sanitized error, usage and the full step timeline in JSON; Markdown includes summary,
report, sources and uncertainty. `test/integration/isolation.test.ts` asserts both
formats, download headers and cross-user 404 behavior; CI run `41742072347` passed
historically for parent `18725fb`.

**M8 — RESOLVED (historical).** `LICENSE` exists with the Apache-2.0 text,
`package.json` declares `Apache-2.0`, and `README.md` links the file.

**M9 — RESOLVED (historical).** `packages/browser-tools/test/search.test.ts` drives
`SearxngSearchProvider` against a local HTTP server (mapping, limit, non-HTTP
filtering, error status, abort) and covers `FixtureSearchProvider` and
`NoopSearchProvider`.

**M10 — RESOLVED (2026-10-31, `2ce1ac8`; historical probe).** The seccomp profile
allows `unshare(CLONE_NEWUSER)`, `clone(CLONE_NEWUSER|…)` and the zygote's
`clone(CLONE_NEWPID/NEWNET)`; `CAP_SYS_CHROOT` is kept. Probe run `41226712667`
produced `LAUNCH_OK sandbox=true` **and** `PAGE_OK`; CI asserts `sandbox: true`.
See `docs/VERIFICATION_REPORT.md`.

**M11 — PARTIALLY RESOLVED; ONE ITEM REMAINS (2026-11-04).** DNS resolution is pinned
through the enforcing proxy; IPv6 URL brackets are normalized before address
classification, so public IPv6 literals are accepted and private/reserved ranges
remain blocked. Still open: the admin `browserAllowedPorts`/`browserAllowHttp`
settings are not forwarded to the runner; the service currently applies its
deployment-level environment policy. This remains an explicit settings/transport
decision, not a claim that the UI values affect egress.

### Low

**L1 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).** The runner now enforces
`robots.txt` for main-frame navigations and redirect targets, failing closed on
unreachable policy files. Site ToS, licensing and site-specific rate limits remain
operator responsibilities; captcha/paywall bypass is out of scope. See
`services/browser-runner/src/robots-policy.ts`, `browser.ts`, their focused tests,
and `docs/security/browser-isolation.md`.

**L2 — RESOLVED (2026-11-03; historical).** SearXNG no longer carries a Watchtower
label; only `api` and `worker` set
`com.centurylinklabs.watchtower.enable: "true"`.

**L3 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04; targeted test passed).** Both
`/api/invitations/:token` and `/api/invitations/:token/preview` now call the same
state-checked `previewInvitation`/`findUsableInvitation` lookup, so accepted, revoked
and expired tokens answer 404 with the same body as an unknown token.
`test/integration/invitation-preview.test.ts` (5 passed on an isolated migrated
Postgres) covers usable, expired, revoked, accepted and unknown tokens on both routes.

**L4 — RESOLVED IN THE IMPLEMENTATION BATCH (2026-11-04).**
`collectKnownSecrets` adds the resolved API key and every other credential row for
the provider; `providerHeaderSecrets` adds values only for credential-like header
names, so ordinary metadata such as `X-Title` remains readable. Executor errors,
timeline arguments/previews and notification failures use the redaction set. The
post-review focused test covers the header classification.

**L5 — RESOLVED (2026-11-04; obsolete source finding).** The current executor does
not compute and discard a separate `reportToMarkdown` value. It stores one structured
report with a provenance-checked Markdown body; the export is a deterministic
projection of that report, while the UI renders the body and its source/uncertainty
fields in their respective views. Export framing (title and generation time) is
intentionally not duplicated into the stored model answer.

**L6 — RESOLVED (2026-11-04; historical counts).** The Ollama mid-body regression is a
normal passing test (not `it.fails`): `OllamaProvider.chat` maps body-read failures to
the typed `unavailable` error, and `packages/ai-providers/test/ollama.test.ts` verifies
it. The focused Ollama suite passed 15 tests in the current targeted run; older
`docs/VERIFICATION_REPORT.md` entries remain dated snapshots.

**L7 — OPEN (not claimed by requirement 12).** Only `format=json|md` exist; there is
no CSV export.

**L8 — RESOLVED (2026-11-04).** Markdown export now rechecks report-body links against
collected sources, escapes untrusted task/source titles and uncertainty text, and
only emits clickable source citations for HTTP(S) URLs with embedded credentials
removed. `packages/shared/test/report.test.ts` asserts hostile text cannot create an
extra link in the export.

### Verification gates (not code findings)

**G1 — E-mail verification implemented; current integration gate unavailable.** The
implementation sends verification mail through the configured mail transport and
requires verification. An earlier full integration run passed 148 tests across 19
files; the current working-tree integration attempt stopped before assertions because
PostgreSQL was unavailable. Requirement 02 #7 remains implemented in code, but this
batch does not claim a current integration pass.

**G2 — Excluded / environment-scoped gates.** Production deployment and real-provider
verification remain excluded by scope. CI `41742072347` is evidence for `18725fb`
only. The earlier isolated Compose start and Playwright E2E used the test-only fake
runtime/provider and are historical; the current working tree has only config/parity
verification, not a full stack start or E2E run.

---

## Product and safety decisions deferred

- OpenCode Web embedding is rejected; Agent Tasks remains the system of record and
  OpenCode remains the execution backend (`docs/architecture/opencode-web-research.md`).
- Kitesurf and Cloudflare integrations are deferred until after v1.
- Approval pause, additional notification channels/settings, model-authored structured
  uncertainty extraction, transport of browser egress settings to the runner, and
  event-triggered tasks before a connector layer exists remain open product/safety
  decisions; no implementation is claimed for them.

## Verification boundaries

- **Integration:** the full suite passed 148 tests across 19 files against the
  isolated PostgreSQL instance. Earlier targeted runs are superseded by this run.
- **Pre-review unit and web tests:** `pnpm test:unit` reported 568 tests (4 skipped;
  41 files passed, 1 skipped); the web suite passed 101 tests across 19 files.
- **Pre-review static gates:** frozen install, `pnpm lint`, `pnpm -r typecheck`,
  `ratchet check` (11/11) and `git diff --check` passed on that implementation snapshot.
- **CI and E2E:** CI run `41742072347` passed integration and Playwright E2E for parent
  `18725fb`, including worker recovery and the mail flow. It predates this batch. The
  pre-review local isolated Compose start and Playwright E2E passed 11/11 with the
  test-only fake runtime/provider; post-review E2E is not claimed unless rerun below.
- **Production deployment:** intentionally not performed or verified. CI's test
  Compose stack does not establish production readiness.
- **Live providers:** no real OpenAI-compatible endpoint, Ollama, Codex or SearXNG
  service was contacted; verification uses deterministic test services.
- **Chromium sandbox / user namespaces:** depends on the kernel and container
  runtime; the historical probe and CI exercised the sandbox in a test Compose
  environment, not on the production host.
- **DNS rebinding in a real browser:** the proxy is tested with an injected resolver,
  not with a real rebinding domain.
- **LLM-driven prompt injection:** requires a live model; tests use the test provider.
