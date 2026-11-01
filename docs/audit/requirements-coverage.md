# Requirements coverage audit

**Scope:** `docs/requirements/01..14` (101 acceptance criteria) against the code in this
working tree.
**Snapshot:** 2026-10-31 12:17 UTC, `main` with **zero commits** (`git log` → "does not
have any commits yet"; 30 untracked path groups).
**Auditor stance:** the requirement documents and `docs/VERIFICATION_REPORT.md` are
treated as claims, not evidence. Every status below was derived by reading the code and
looking for a test that exercises it.

> **Concurrency warning:** this tree was being edited while the audit ran. Between
> 12:08 and 12:16 the following changed: `compose.yaml` (SearXNG profile),
> `pnpm-workspace.yaml` (temporarily contained an unrecognised pnpm setting, which
> broke `pnpm lint`/`pnpm -r typecheck` for about a minute), `packages/ai-providers/test/ollama.test.ts`
> and `test/fake-ollama.ts` (new, 13 tests), and `apps/web` build output. Statuses and
> line numbers are for the snapshot above; re-check before acting on a Low finding.

## Legend

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED` | The code exists and does what the criterion says; a test exercises the behaviour where the behaviour is runtime-dependent. |
| `PARTIAL` | Code exists but a stated property is missing or is not true in every path. The gap is named. |
| `MISSING` | No code implements it. |
| `UNPROVEN` | Code exists, but no test in `test/`, `packages/*/test/`, `apps/*/test/`, `services/*/test/` or `e2e/` exercises it (or the only test is an `it.fails` that asserts the bug). |

## Commands actually run

```
pnpm test:unit        -> 7 files, 75 passed + 1 expected fail (76)
pnpm -r typecheck     -> 10 projects, exit 0
pnpm lint             -> exit 0
ratchet check         -> 5/5 gates passed
git log / git ls-files-> no commits, nothing tracked
```

Not run, per the brief: `test/integration/**`, `pnpm test:e2e`, any compose stack.

## Summary

| Metric | Count |
| --- | ---: |
| Acceptance criteria | **101** |
| `IMPLEMENTED` | **70** |
| `PARTIAL` | **21** |
| `MISSING` | **2** |
| `UNPROVEN` | **8** |

Per document:

| Doc | Criteria | Implemented | Partial | Missing | Unproven |
| --- | ---: | ---: | ---: | ---: | ---: |
| 01 repository & CI | 8 | 6 | 2 | 0 | 0 |
| 02 authentication & roles | 10 | 6 | 3 | 0 | 1 |
| 03 multi-user isolation | 6 | 5 | 1 | 0 | 0 |
| 04 tasks & timezones | 7 | 7 | 0 | 0 | 0 |
| 05 durable scheduling | 9 | 6 | 2 | 0 | 1 |
| 06 AI providers | 8 | 6 | 2 | 0 | 0 |
| 07 Codex adapter | 5 | 3 | 1 | 1 | 0 |
| 08 agent runtime | 7 | 5 | 2 | 0 | 0 |
| 09 web research | 7 | 4 | 0 | 1 | 2 |
| 10 browser isolation & egress | 8 | 6 | 1 | 0 | 1 |
| 11 prompt injection & XSS | 8 | 5 | 3 | 0 | 0 |
| 12 reports & exports | 5 | 2 | 3 | 0 | 0 |
| 13 web UI | 6 | 4 | 0 | 0 | 2 |
| 14 deployment | 7 | 5 | 1 | 0 | 1 |

## Checkbox mismatches — `[x]` in the doc, not fully true in the code

28 of the 101 criteria are checked in the requirement documents but are **not** fully
implemented, not implemented at all, or have no test at all. The unchecked boxes
(doc 09 robots.txt, doc 09 captcha, doc 13 E2E, doc 14 compose start) are honest and
are not listed here.

| Doc | Criterion (checked `[x]`) | Audit |
| --- | --- | --- |
| 01 | Shared versions through a pnpm catalog | PARTIAL — `drizzle-orm@^0.45.4` and `pg-boss@^12.38.0` are still duplicated outside the catalog. |
| 01 | Apache-2.0 license | PARTIAL — no `LICENSE` file exists; only `package.json` says `Apache-2.0`. README links a missing `LICENSE`. |
| 02 | Public registration disabled; single-use invitations (7 days) | PARTIAL — not atomic, and the sign-up bridge never marks the invitation accepted. |
| 02 | TOTP MFA with backup codes, verified before activation | PARTIAL — server-side flow is tested; backup codes are untested and the web UI has no TOTP step. |
| 02 | Password reset **and email verification** through SMTP | PARTIAL — verification mail can never be triggered. |
| 03 | Malformed ids return 404 instead of a database error | PARTIAL — only task/execution ids are validated; provider/invitation uuid params still reach PostgreSQL. |
| 05 | Execution timeouts | PARTIAL — a timeout is retried as a transient provider error; `timed_out` is effectively unreachable. |
| 05 | Per-user concurrency and daily quota | PARTIAL — enforced only after claim, off-by-one, and untested. |
| 06 | A model without the `tools` capability is refused | PARTIAL — refusal requires a non-empty capability list; a failed probe silently proceeds. |
| 06 | Model tool support is declared, never assumed | PARTIAL — the runtime never consults the declared capability before sending tools. |
| 07 | Adapter exists but is disabled by default | PARTIAL — the admin API strips `enabled`/`codexHome`, so it can never be enabled through the product. |
| 07 | Account-scoped: per-user `CODEX_HOME`, no shared accounts | **MISSING** — one global provider row is read; there is no user → directory mapping. |
| 08 | Tools include `fill_form` | PARTIAL — the tool exists but is never offered (`allowForms: false`), so the model sees nine tools, not ten. |
| 08 | Limits enforced per step, tool call, page visit, search query, output size, duration | PARTIAL — the tool-call budget throws a cancelled error, and output/duration limits are only partially applied. |
| 10 | Chromium sandbox enabled in the supported deployment | **RESOLVED** — probe run 41226712667 launched and rendered a page with the shipped posture; CI asserts `sandbox: true`. |
| 11 | Clicks on login/checkout/payment/destructive controls refused | PARTIAL — substring match on the target label only. |
| 11 | Secret redaction in logs, errors and provider messages | PARTIAL — only the active API key is treated as a secret. |
| 11 | Credentials never returned by any API response | PARTIAL — `/api/admin/providers` returns the raw provider `config` (including `headers`). |
| 12 | Markdown + JSON export | PARTIAL — JSON omits the tool timeline/errors; Markdown omits summary and uncertainty; no test. |
| 12 | No invented links | PARTIAL — the sources list is tool-derived, but the report Markdown can contain unvalidated model links. |
| 12 | Historical comparison through the execution list per task | PARTIAL — a per-task list exists; no comparison exists. |
| 14 | Watchtower labels for api/worker/web only | PARTIAL — SearXNG also carries `watchtower.enable: "true"`. |
| 02 | Audit log for every sensitive administrative operation | UNPROVEN — writes exist, no test asserts them (and Better Auth admin endpoints write none). |
| 05 | Graceful shutdown aborts running executions | UNPROVEN — `abortAll()` exists; no test covers the signal path. |
| 09 | SearXNG JSON adapter | UNPROVEN — no test drives `SearxngSearchProvider`. |
| 09 | Fixture and no-op providers for deterministic tests | UNPROVEN — providers exist, no test uses them. |
| 10 | Every redirect hop re-validated | UNPROVEN — true by proxy design, no redirect test. |
| 13 | Accessible controls, labels, loading/error/empty states | UNPROVEN — no a11y assertion anywhere. |

---

## 01 — Repository, license, workspace and CI

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | pnpm workspace with the claimed layout | IMPLEMENTED | `pnpm-workspace.yaml:1-4`; `apps/{web,api,worker}`, `services/browser-runner`, six packages | structural |
| 2 | Shared versions through a pnpm catalog | PARTIAL | `pnpm-workspace.yaml:11-18` (fastify/pg/zod/tsx/tsup/typescript/vitest); `drizzle-orm` `^0.45.4` still in `apps/api`, `apps/worker`, `packages/database`; `pg-boss` `^12.38.0` in api and worker | none |
| 3 | Apache-2.0 license, README, CHANGELOG, CONTRIBUTING | PARTIAL | `package.json:7` says `Apache-2.0`; **no `LICENSE` file** (`ls LICENSE*` fails); `README.md` "See LICENSE" | none |
| 4 | Strict TypeScript, typecheck every project | IMPLEMENTED | `tsconfig.base.json:5-13` (`strict`, `noUncheckedIndexedAccess`); 10 projects have `typecheck`; `pnpm -r typecheck` exit 0 | command |
| 5 | ESLint flat config | IMPLEMENTED | `eslint.config.js`; `pnpm lint` exit 0 | command |
| 6 | CI: lint, typecheck, unit, integration (Postgres), E2E, image build, Trivy, gitleaks | IMPLEMENTED | `.github/workflows/ci.yml` jobs `lint-typecheck`, `unit`, `integration` (postgres service), `e2e`, `docker`, `security` | CI never ran here |
| 7 | Repo-local hooks: secret scan, ratchet, lint, typecheck, codegraph | IMPLEMENTED | `.githooks/pre-commit:6-33`; `core.hooksPath=.githooks` | hook script |
| 8 | Ratchet gates with a committed baseline | IMPLEMENTED | `ratchet.config.jsonc`, `ratchet.baseline.json`; `ratchet check` 5/5. **Not committed** (ratchet prints "baseline is not committed yet") and no CI step runs it | command |

## 02 — Authentication, roles and account lifecycle

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Email/password, minimum length 12 | IMPLEMENTED | `apps/api/src/auth.ts:30`; `routes/setup.ts:52` | no test for an 11-char password |
| 2 | Registration closed; single-use 7-day invitations | PARTIAL | `app.ts:84-95` checks the token; `setup.ts:73-92` (SELECT then signUp then UPDATE, **no transaction, no `FOR UPDATE`**); `app.ts` never sets `acceptedAt`; expiry `setup.ts:79` | `auth.test.ts:98-135` (reuse after accept), `:383-390` (revoked); **no expiry test, no concurrency test** |
| 3 | First admin via `SETUP_TOKEN`, refused afterwards | IMPLEMENTED | `setup.ts:45-52`; count checked before insert | `auth.test.ts:17-43` |
| 4 | Session revocation on next request | IMPLEMENTED | `auth.ts:56-58` (`cookieCache.enabled=false`); `lib/session.ts:19` reads DB each request | `auth.test.ts:52-71` |
| 5 | TOTP MFA with backup codes, verified before activation | PARTIAL | `auth.ts:90`; `schema.ts` twoFactor has `backupCodes`; but no web UI route/field (`App.tsx` 44-75) and `lib/api.ts:96-97` ignores `twoFactorRedirect` | `auth.test.ts:149-193`; no backup-code test |
| 6 | Rate limits on sign-in, TOTP, reset, sign-up | IMPLEMENTED | `auth.ts:76-87` | only sign-in is asserted (`auth.test.ts:195-210`) |
| 7 | Password reset + email verification via SMTP (log in dev) | PARTIAL | `mailer.ts:14-35`; reset sender `auth.ts:33-40`; **verification can never fire** (`sendOnSignUp:false` at `:42`, no caller, `requireEmailVerification:false` at `:32`) | none |
| 8 | Admin-only user management, last-admin guard | IMPLEMENTED | `routes/admin.ts:81-118`; guard `:94-97` | last-admin only (`isolation.test.ts:372-381`) |
| 9 | Audit log for every sensitive admin op | UNPROVEN | `context.ts:41-52`; calls in `admin.ts:110,161,174,189`, providers, tasks | no assertion anywhere |
| 10 | CSRF: Better Auth origin + explicit origin guard | IMPLEMENTED | `app.ts:52-58` (POST/PUT/PATCH/DELETE only); `auth.ts:64-65` trusted origins; SameSite Lax `auth.ts:69` | `auth.test.ts:137-147`; note: a request **without** an `Origin` header passes |

## 03 — Strict multi-user isolation

Route inventory checked: 45 app routes (`apps/api/src/routes/*.ts`) plus the
`/api/auth/*` wildcard in `app.ts:117`. Every task- and
execution-scoped handler's `where` clause contains `ownerId = me.id` (tasks.ts lines
55, 112, 127, 158, 169, 183, 195, 203, 214, 247, 274, 303, 329, 347, 363, 394).

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Every query scoped with `owner_id = session.user.id` | IMPLEMENTED | list above; `scheduling.ts` uses `owner_id` from the task row; provider/admin queries are global by design | `isolation.test.ts:264-319` |
| 2 | Client `ownerId`/`id` ignored on create | IMPLEMENTED | zod strips unknown keys; explicit insert `tasks.ts:73-92` | `isolation.test.ts:357-370` |
| 3 | Malformed ids → 404, not a DB error | PARTIAL | `lib/session.ts:39-45` used in tasks.ts only; `providers.ts:44-46`, `providers.ts:115-117`, `admin.ts:166-168` pass raw uuid params → PG `22P02` → `app.ts:60-70` answers 500 | only task ids tested |
| 4 | Admin role grants no access to user tasks/executions/credentials | IMPLEMENTED in the app routes — **but see Critical C1 (impersonation)** | `admin.ts:63-233` is admin-only; user reads check `ownerId` | `isolation.test.ts:314-319` |
| 5 | Personal credentials per-owner; shared explicit | IMPLEMENTED | `ai-providers/src/registry.ts:37-48`; `schema.ts:196-218`; routes `providers.ts:44-68` | `isolation.test.ts:321-344`; shared upsert bug M2 |
| 6 | Background execution re-derives ownership from the task row | IMPLEMENTED | `executor.ts:51-59` join; `:107-108` resolves credentials for `task.ownerId` | `execution.test.ts` |

## 04 — Task management and timezones

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | All listed task fields | IMPLEMENTED | `schema.ts:230-267`; `shared/src/schemas.ts:37-49` | `task-schema.test.ts` (form) |
| 2 | CRUD, pause/resume, run-now, duplicate, history | IMPLEMENTED | `routes/tasks.ts:49-298` | create/read/patch/delete/run/pause covered; **resume, duplicate, retry, full history not covered** |
| 3 | Presets once/daily/weekdays/weekly/monthly/custom | IMPLEMENTED | `shared/src/schedule.ts:9-80` | `schedule.test.ts:18-32` |
| 4 | UTC storage, schedule in IANA zone | IMPLEMENTED | `timestamptz` columns; `nextOccurrence` `schedule.ts:94-104` | `schedule.test.ts:34-39` |
| 5 | Spring-forward gap runs at 03:30 | IMPLEMENTED | `schedule.ts:94-104` | `schedule.test.ts:41-46` (passes) |
| 6 | Fall-back runs once at the first instant | IMPLEMENTED | same | `schedule.test.ts:48-53` (passes) |
| 7 | Limits capped by hard maxima and enforced | IMPLEMENTED | `shared/src/limits.ts:11-28`; zod caps in `taskInputSchema`; loop enforcement `runtime.ts:101,154,184` | page-visit and step limits tested; tool-call/duration/output not |

## 05 — Durable scheduling

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | pg-boss queues for tick, recovery, execution | IMPLEMENTED | `worker/src/index.ts:20-21` schedules, `:23,35,43` workers; `queues.ts:17-23` creates all three | indirect |
| 2 | `FOR UPDATE SKIP LOCKED` + unique occurrence | IMPLEMENTED | `scheduling.ts:21-52`; unique index `schema.ts:265` / migration `0000:231` | `scheduler.test.ts:42-56,72-79` |
| 3 | Multiple workers safe (claim flips queued→running) | IMPLEMENTED | `scheduling.ts:59-76` | `scheduler.test.ts:81-95` |
| 4 | Leases and crash recovery (requeue/cancel) | IMPLEMENTED | `scheduling.ts:78-80,106-123`; sweep every 2 min `worker/src/index.ts:21` | `scheduler.test.ts:97-113` |
| 5 | Retries with backoff, max 3 | IMPLEMENTED | `executor.ts:23,223-233` (`startAfter: 30 * attempt`) | `execution.test.ts:283-295` (allows failed or queued) |
| 6 | Execution timeouts and cancellation polling | PARTIAL | poll `executor.ts:89-94`; deadline `:97`; **but** an abort during a provider call surfaces as `ProviderError('timeout')` (`openai-compatible.ts:158-160`) → retried, not `timed_out` | none for timeout |
| 7 | Per-user concurrency and daily quota | PARTIAL | `executor.ts:68-84`; only after claim; `>` allows max+1; `countRunningForOwner` counts the current row; nothing at enqueue time | **none** |
| 8 | Graceful shutdown aborts running executions | UNPROVEN | `worker/src/index.ts:58-64`; `executor.ts:39-41` | no signal test |
| 9 | Documented at-least-once semantics | IMPLEMENTED | `docs/architecture/overview.md:47,79`; `ARCHITECTURE.md:67` | doc |

## 06 — AI providers

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Ollama: discovery, capability, tools, timeouts, errors | IMPLEMENTED | `ollama.ts:44-61,82-87,104-124` | `packages/ai-providers/test/ollama.test.ts` (13 tests incl. `it.fails`) |
| 2 | Model without `tools` capability refused | PARTIAL | `ollama.ts:82-87`: `capabilities.length > 0 && !includes('tools')` — a failed `/api/show` returns `[]` and proceeds | `ollama.test.ts` covers the non-empty case only |
| 3 | OpenAI-compatible with base URL, headers, timeouts | IMPLEMENTED | `openai-compatible.ts:46-56,154-166` | `openai-compatible.test.ts` |
| 4 | Honest User-Agent + stable `x-opencode-session` | IMPLEMENTED | `openai-compatible.ts:46-56`; `runtime.ts:156-161` passes one id per run | `openai-compatible.test.ts:202-231`; mock-openai rejects generic UA/session |
| 5 | Records `opencode.allowance` | IMPLEMENTED | `openai-compatible.ts:197-208` | `openai-compatible.test.ts:214-231` |
| 6 | Tool support declared, never assumed | PARTIAL | discovery defaults false (`:155-158`), but `chat` only refuses if the model is in `config.models`; the executor never checks `providerModels.supportsTools` | none |
| 7 | `packages/mock-openai` real HTTP server enforcing the contract | IMPLEMENTED | `mock-openai/src/index.ts:82-140` | `openai-compatible.test.ts:265-281` |
| 8 | Credentials per-user/shared, never sent to the runner | IMPLEMENTED | `registry.ts:37-48`; `browser-tools/src/client.ts` sends only actions | no explicit assertion |

## 07 — Codex / ChatGPT integration

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Adapter exists, disabled by default | PARTIAL | guard `codex.ts:23-35`; but the admin API parses every non-Ollama kind with `compatibleConfigSchema` (`providers.ts:104`) which **strips** `enabled` and `codexHome`, so the guard can never be satisfied through the product | none |
| 2 | Per-user `CODEX_HOME`, no shared accounts | **MISSING** | `codexHome` comes from one global provider row (`codex.ts:30-34`); there is no user → codexHome mapping | none |
| 3 | No browser cookies, undocumented endpoints, token extraction | IMPLEMENTED | `codex.ts:53-95` only spawns `codex exec` | none |
| 4 | Text-only: refuses tool calling | IMPLEMENTED | `codex.ts:55-57` | none |
| 5 | Documented limitation (Go ≠ API credit) | IMPLEMENTED | `docs/architecture/providers.md` Codex section | doc |

## 08 — Agent runtime

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Ten named tools | PARTIAL | all ten in `tools.ts:240-251`; `allowForms` is hardcoded `false` in `executor.ts:129`, and `runtime.ts:117-119` excludes `fill_form` from the offered tools | `runtime.test.ts:146-161` asserts the inventory, not usability |
| 2 | No shell, JS, filesystem | IMPLEMENTED | only the ten tools exist; `runtime.test.ts:90-99` (`run_shell` refused) | `runtime.test.ts:90-99` |
| 3 | Every call validated + allowlist, unknown refused | IMPLEMENTED | zod per tool; allowlist `runtime.ts:189-190` | `runtime.test.ts:90-99` |
| 4 | Limits per step/tool/page/search/output/duration | PARTIAL | `runtime.ts:154,184,230`; `tools.ts:56-61,89-95`; tool-call overflow throws `AgentCancelledError('step_limit')` which the executor records as **cancelled** (`executor.ts:213-218`) | page-visit/step tested; tool-call/duration/output not |
| 5 | Retrieved content wrapped as untrusted | IMPLEMENTED | `prompt.ts:3-9,46-53` | `runtime.test.ts:101-111` |
| 6 | Sources collected, deduped, persisted with confidence | IMPLEMENTED | `runtime.ts:77-84`; `executor.ts:159-165,172-187`; `execution_sources` unique index | `execution.test.ts:275-277` |
| 7 | Final answer stored as Markdown + summary/sources/uncertainty | IMPLEMENTED | `executor.ts:159-165` (`report` jsonb) | `execution.test.ts:260-267` |

## 09 — Web research

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | SearXNG JSON adapter, composable interface | UNPROVEN | `browser-tools/src/search.ts:16-51` | no test constructs `SearxngSearchProvider` |
| 2 | Fixture and no-op providers | UNPROVEN | `search.ts:52-61` | no test uses `FixtureSearchProvider`/`NoopSearchProvider` |
| 3 | Visited URLs, timestamps, titles, excerpts per execution | IMPLEMENTED | `tools.ts:97-113`; `executor.ts:172-187` | `execution.test.ts:275-277` |
| 4 | Inaccessible pages reported as errors, not invented | IMPLEMENTED | `tools.ts:100-103`; blocked test | `execution.test.ts:297-315` |
| 5 | Domain/redirect validation in the browser layer | IMPLEMENTED | `browser.ts:150-153`; proxy `proxy.ts:63-70` | `net.test.ts`, `egress.test.ts`; redirect hop untested |
| 6 | robots.txt/TOS documented as operator responsibility | **MISSING** | the only mention is `docs/requirements/09-web-research.md:16`; grep of README/docs/SECURITY/DEPLOYMENT finds no operator note | none (and the box is honestly unchecked) |
| 7 | Captcha/paywall out of scope | IMPLEMENTED | recorded decision, no code needed | n/a |

## 10 — Browser isolation and egress

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Separate service, non-root, no caps, read-only, pids/memory | IMPLEMENTED | `compose.yaml:128-137`; `Dockerfile.runner:22` (`USER pwuser`) | config |
| 2 | No published port, no docker socket, no host networking | IMPLEMENTED | `compose.yaml:110-146` (no `ports:` for the runner) | config |
| 3 | Chromium sandbox enabled | **RESOLVED** | seccomp allows `unshare`/`clone(CLONE_NEWUSER)` and the zygote's `clone(CLONE_NEWPID/NEWNET)`; `CAP_SYS_CHROOT` retained; probe run 41226712667: `LAUNCH_OK sandbox=true` + `PAGE_OK`; CI asserts `sandbox: true` | `seccomp-profile.test.ts`, CI E2E |
| 4 | Fresh context, downloads off, non-http(s) aborted | IMPLEMENTED | `browser.ts:82-107` (`acceptDownloads:false`, route abort) | integration/E2E exercises sessions |
| 5 | Enforcing proxy resolves, checks all answers, pins | IMPLEMENTED | `proxy.ts:63-70,72-102`; `net.ts:210-226` | `egress.test.ts:330-355` |
| 6 | Blocks loopback/RFC1918/link-local/metadata/CGNAT/multicast/reserved/IPv6/mapped/NAT64 | IMPLEMENTED | `net.ts:50-129`; proxy calls it | `net.test.ts` (18 classifications), `egress.test.ts:330-355` |
| 7 | Every redirect hop re-validated | UNPROVEN | every Chromium request goes through the proxy (`browser.ts:46-47`), so it holds by design | no redirect fixture |
| 8 | Session closed after execution | IMPLEMENTED | `executor.ts:196-201`; `client.ts:57-66` (DELETE without JSON content type) | `execution.test.ts:193-198` (sessions == 0) |

## 11 — Prompt injection, XSS, CSRF, secrets

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | System/user/retrieved separated, web text untrusted | IMPLEMENTED | `prompt.ts:3-9,22-40`; `runtime.ts:145-148` | `runtime.test.ts:101-111` |
| 2 | No execution of model code/shell/unrestricted requests | IMPLEMENTED | allowlist `runtime.ts:117-119` | `runtime.test.ts:90-99` |
| 3 | Login/checkout/payment/destructive clicks refused | PARTIAL | `browser.ts:175-183` matches substrings of `innerText`/`aria-label`; an empty label or "Continue" on a checkout page passes | none |
| 4 | Form submission disabled by policy | IMPLEMENTED | `executor.ts:129`; `tools.ts:168-169` | none |
| 5 | Markdown via `rehype-sanitize`, no raw HTML sink | IMPLEMENTED | `ExecutionDetailPage.tsx` + web test; ratchet `no-raw-html` = 0 | `markdown-safety.test.tsx` |
| 6 | Origin guard on state-changing app routes | IMPLEMENTED | `app.ts:52-58` | `auth.test.ts:137-147` |
| 7 | Secret redaction in logs/errors/provider messages | PARTIAL | `app.ts:20-29` (headers only); `redact()` called in `executor.ts:146,227,237` with **only the current apiKey** | none |
| 8 | Credentials never returned by an API response | PARTIAL | `/api/providers` is whitelisted (`providers.ts:26-41`), but `/api/admin/providers` returns `config: provider.config` verbatim (`providers.ts:92`), and `config.headers` is the documented place for bearer tokens | none |

## 12 — Reports and exports

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Metadata, tool timeline, sources, Markdown report, usage, sanitized errors | IMPLEMENTED | `executor.ts:136-148,159-165`; `tasks.ts:323-339` | `execution.test.ts` |
| 2 | Markdown + JSON export with `Content-Disposition` | PARTIAL | `tasks.ts:388-410`; JSON body is `{id, taskId, status, report, usage}` (no steps/error/duration), Markdown omits summary and uncertainty | only the cross-user 404 is tested (`isolation.test.ts:303-304`) |
| 3 | Clickable sources with timestamps and confidence | IMPLEMENTED | `ExecutionDetailPage.tsx` sources tab; `execution_sources` | `execution.test.ts:275-277` |
| 4 | No invented links: sources from tool results only | PARTIAL | `onSource` only in `open_url`/`click_element` (`tools.ts:110,405`); report Markdown itself is unvalidated model output | none |
| 5 | Historical comparison via the per-task execution list | PARTIAL | `tasks.ts:268-298`, `TaskDetailPage.tsx:28-31` — a list, no comparison | none |

## 13 — Web UI

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Login, setup, invite, dashboard, tasks, editor, executions, detail, settings, admin users/providers/audit/monitoring | IMPLEMENTED | `App.tsx:44-75`; one page file per route | E2E covers a subset (CI only) |
| 2 | Responsive, daisyUI, Tailwind v4 | IMPLEMENTED | `apps/web/package.json` (`daisyui ^5.7.50`, `tailwindcss ^4.3.3`); classes throughout | none |
| 3 | Full en/de Lingui 6 PO catalogues, language persisted | IMPLEMENTED | `src/locales/en|de/messages.po` — 444 msgids each, no gaps; `i18n/index.ts:27-45` localStorage | `i18n.test.tsx` (3), E2E language switch |
| 4 | Accessible controls, labels, loading/error/empty states | UNPROVEN | labels/aria exist (e.g. `AdminTabs.tsx:15`, `ExecutionDetailPage.tsx` tablist) | no a11y test |
| 5 | Markdown report rendered sanitized | IMPLEMENTED | `ExecutionDetailPage.tsx` `rehypeSanitize` | `markdown-safety.test.tsx` (3) |
| 6 | E2E against the real API (box unchecked) | UNPROVEN | `e2e/agent-tasks.spec.ts` (9 tests), CI job; not run locally | not run here |

## 14 — Deployment and operations

| # | Criterion | Status | Evidence | Test coverage |
| ---: | --- | --- | --- | --- |
| 1 | Compose: API+SPA, worker, postgres, hardened runner | IMPLEMENTED | `compose.yaml` | not started |
| 2 | Optional profiles: SearXNG, Mailpit | IMPLEMENTED | `compose.yaml` profiles `search`, `mail` (no local-ai profile) | not started |
| 3 | Named volumes, health checks, restart policies, no DB port | IMPLEMENTED | `compose.yaml:30-46,191-193`; postgres has no `ports:` | not started |
| 4 | Pinned images, minimal privileges, seccomp | IMPLEMENTED | postgres `17.5-alpine`, node `22.20.0`, playwright `v1.64.1` (Chromium headless shell installed at build); `docker/seccomp-browser.json`; `cap_drop` on api/worker/runner | not started |
| 5 | Watchtower labels for api/worker only | IMPLEMENTED | api/worker true, runner false | config |
| 6 | README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, `.env.example` | IMPLEMENTED | all eight files exist at the root | doc |
| 7 | Full compose start verified (box unchecked) | UNPROVEN | not run (Docker daemon unavailable to this host) | not run |

---

## Findings

### Critical

**C1 — Administrator impersonation defeats the "admin has no access to user data"
guarantee.**
`apps/api/src/auth.ts:91-95` registers Better Auth's `admin()` plugin with
`impersonationSessionDuration: 60 * 60`. `app.ts:117` forwards every
`/api/auth/*` method to Better Auth, so `POST /api/auth/admin/impersonate-user`
is mounted for admins. `lib/session.ts:18-37` builds the session from
`session.user.id` and **never checks `session.session.impersonatedBy`**, so every
owner-scoped query then runs as the victim. Requirement 03 ("Administrator role
grants no access to user tasks, executions or credentials") and the README
("Admin rights never imply access to a user's task, report or credential") are
therefore false.
*Minimal fix:* reject sessions with `impersonatedBy` in `sessionUser` (and/or do not
expose the impersonation endpoint), then add an isolation test that calls
`/api/auth/admin/impersonate-user` and asserts 403/404 on the victim's task.

### High

**H1 — The last-admin guard, the audit log and the invite-only flow can be bypassed
through `/api/auth/admin/*`.**
The same plugin exposes `admin/set-role`, `admin/ban-user`, `admin/remove-user`,
`admin/create-user` and `admin/set-user-password`. These write no `audit_logs` row,
do not consult the guard in `routes/admin.ts:94-97`, and `admin/create-user`
creates accounts without an invitation. Requirement 02's "audit log for every
sensitive administrative operation" and "onboarding only through single-use
invitations" only hold for the custom routes.
*Minimal fix:* add a Better Auth `databaseHooks`/`hooks` layer that enforces the
last-admin rule and writes the audit entry, or disable the plugin endpoints and keep
only the app routes.

**H2 — Invitations are not atomically single-use, and the sign-up bridge never
consumes them.**
`routes/setup.ts:73-92` performs `SELECT` → `signUpEmail` → `UPDATE acceptedAt`
outside a transaction and without `FOR UPDATE`; two concurrent accepts both see an
unused row. `app.ts:84-95` accepts `POST /api/auth/sign-up/email` with a valid
`x-invite-token` but never sets `acceptedAt`, so the invitation stays "pending" and
the only thing preventing a second account is Better Auth's unique email. A similar
check-then-insert race exists in `POST /api/setup` (`setup.ts:46-54`): two requests
carrying `SETUP_TOKEN` can both see zero users.
*Minimal fix:* one transaction per accept with
`UPDATE invitations SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
create the user inside it, and have the auth bridge call the same consumer (or route
the bridge through the accept handler). Add expiry + concurrent-accept tests.

**H3 — TOTP MFA cannot be used from the web UI.**
`apps/web/src/lib/api.ts:96-97` posts to `/api/auth/sign-in/email` and treats the
result as a session; `LoginPage.tsx:47-54` then calls `refresh()`, which fails when
Better Auth answers `twoFactorRedirect` (as asserted in `auth.test.ts:170-172`).
There is no TOTP input, no backup-code screen, and no enable-MFA screen anywhere in
`apps/web/src`. A user who enables MFA is locked out of the UI.
*Minimal fix:* handle `twoFactorRedirect` with a second step, add enable/backup-code
UI, and test the backup-code path.

**H4 — Per-user quota and concurrency are enforced late, off by one, and untested.**
`apps/worker/src/executor.ts:68-84` checks limits only after `claimExecution` has
already flipped the row to `running` and already inserted the execution; comparisons
use `>` (`max + 1` executions/day are allowed), and `countRunningForOwner` includes
the current execution. Nothing at enqueue time (`tasks.ts:208-239`) rejects a user
who is over quota, so a user can queue unbounded jobs. `WORKER_CONCURRENCY` is parsed
(`worker/src/env.ts:11`) and logged but **never applied** to `boss.work` (fixed
`batchSize: 1`, `worker/src/index.ts:23`).
*Minimal fix:* check the quota before the insert in the run route and in the tick,
use `>=`, and pass `WORKER_CONCURRENCY` as the pg-boss `teamSize`/batch size. Add a
scheduler/executor test that exercises the limit.

**H5 — A timed-out execution is retried as a transient provider error.**
`executor.ts:97` aborts at `maxDurationSec`, but an abort during `provider.chat`
reaches `openai-compatible.ts:158-160` (and the Ollama equivalent), which maps
`AbortError` to `ProviderError('timeout')`. `executor.ts:223-233` treats `timeout` as
transient and requeues, up to three times. The documented `timed_out` status is
therefore only reachable if the abort is observed between steps. The same path adds a
30 s delay to user cancellation.
*Minimal fix:* in `runAgent`, wrap the provider call and translate an aborted signal
into `AgentCancelledError('timeout')` (or check `deadline` in `failExecution` before
retrying).

**H6 — Codex is not account-scoped per user and cannot be configured at all.**
Requirement 07 claims a per-user `CODEX_HOME`; `codex.ts:30-34` reads `codexHome` from
one global provider row, so every user would share one account. Worse, the admin API
parses all non-Ollama kinds with `compatibleConfigSchema` (`providers.ts:104`,
`shared/src/schemas.ts:17-27`), which strips `codexHome` and `enabled` (zod objects
strip unknown keys). `codex.ts:27-33` requires both, so the adapter is unreachable
through the product even when `AGENT_TASKS_ENABLE_CODEX=1`.
*Minimal fix:* add a dedicated `codexConfigSchema`, store the mapping per owner (or
document it explicitly as single-tenant), and add a guard test.

**H7 — The tree has no commits, so requirement 01's "public repository", "CI fails on
a red gate" and "committed baseline" cannot be evidenced.**
`git log` fails with "current branch 'main' does not have any commits yet";
`git ls-files` is empty; 30 path groups are untracked. `ratchet check` itself prints
"monotonicity skipped: ratchet.baseline.json is not committed yet". This may be an
export artifact of the audit environment, but as delivered the claim is false.
*Minimal fix:* commit the tree, add the baseline, and run CI.

### Medium

**M1 — Malformed UUIDs still produce 500s on provider/invitation routes.**
`requireUuid` is only used in `routes/tasks.ts`. `providers.ts:44,70,115,136,145,162,170,194`
and `admin.ts:166` pass `request.params.id` straight into uuid columns; PostgreSQL
raises `22P02`, `app.ts:60-70` maps it to `internal`/500. Contradicts requirement 03's
checked claim beyond tasks. *Fix:* call `requireUuid` in those handlers.

**M2 — The shared-credential upsert never conflicts.**
`providers.ts:152-158` inserts `owner_id = NULL` and expects
`ON CONFLICT (provider_id, owner_id, label)`. Postgres treats NULLs as distinct, so
re-saving a shared key appends a row instead of updating it; `resolveCredential`
(`registry.ts:37-48`) then picks an arbitrary shared row, and deleted/rotated keys
stay live. *Fix:* use a partial unique index (`WHERE owner_id IS NULL`) or a
`COALESCE(owner_id,'')` expression index, and delete-then-insert in a transaction.

**M3 — `fill_form` is implemented but never offered.**
`executor.ts:129` hardcodes `allowForms: false` and `runtime.ts:117-119` omits the
tool, so the model sees nine tools. The README and requirement 08 say ten. *Fix:*
either remove the tool from the advertised set/docs or wire a per-task permission.

**M4 — The click guard is a label-substring check.**
`browser.ts:175-183` blocks only when `innerText`/`aria-label` contains one of ten
phrases. A submit input with no text, a "Continue" button on a checkout page, or an
icon-only delete control passes. *Fix:* also inspect `input[type=submit]` values,
`name`, the page URL and form method, or deny clicks on non-anchor elements.

**M5 — `/api/admin/providers` returns provider `config` verbatim.**
`providers.ts:92`. `compatibleConfigSchema.headers` (`schemas.ts:20`) is the
documented place for extra auth headers, so any token placed there is echoed to every
admin. The non-admin `/api/providers` correctly whitelists. *Fix:* redact
`config.headers` (or only return names), and keep secrets in `provider_credentials`.

**M6 — Four admin-visible settings have no effect.**
`allowRegistration` (`shared/src/schemas.ts:131`) is exposed in the admin UI and
`/api/config` but the sign-up bridge always requires an invite; `browserAllowHttp`
and `browserAllowedPorts` are stored but the runner reads only environment variables
(`services/browser-runner/src/index.ts:11-15`); `notification: 'email'` is accepted
and displayed but no code sends a notification mail (grep finds only schema/UI). The
UI presents all four as working controls. *Fix:* wire them or remove them.

**M7 — Exports are lossy and untested.**
`tasks.ts:400-403` (JSON) omits `steps`, `error`, `durationMs`, `attempt`; the
Markdown branch (`:407-409`) writes report Markdown + sources but drops `summary` and
`uncertainty` that the stored report has. Only the 404 cross-user case is tested.
*Fix:* serialise the full detail payload and reuse `reportToMarkdown`
(`shared/src/report.ts:22`), then test headers and body.

**M8 — No `LICENSE` file.**
The repository declares Apache-2.0 in `package.json` but ships no license text;
`README.md` links `LICENSE`. *Fix:* add the Apache-2.0 text.

**M9 — The search backend has no tests.**
`SearxngSearchProvider`, `FixtureSearchProvider` and `NoopSearchProvider`
(`browser-tools/src/search.ts:16-61`) are never constructed in any test; the runtime
tests inject an inline fake. Live research is only exercised when the optional
SearXNG container runs. *Fix:* add a fake SearXNG server test (the Ollama adapter now
has one) plus fixture/noop assertions.

**M10 — The Chromium sandbox claim is unverified and probably unusable as configured.**
`compose.yaml:125` sets the sandbox on, but the container runs as `pwuser` with
`cap_drop: [ALL]` and `no-new-privileges`, so Chrome's setuid sandbox cannot gain
privileges; only unprivileged user namespaces could work. The verification host has
no userns (`execution.test.ts:171-176` starts the runner with
`RUNNER_CHROMIUM_SANDBOX=false`). *Fix:* either enable userns explicitly in the
runner service (`security_opt: seccomp` profile allowing `CLONE_NEWUSER`) and add a
startup smoke test, or document the constraint honestly.

> **Resolved (2026-10-31, `2ce1ac8`):** the profile now allows
> `unshare(CLONE_NEWUSER)`, `clone(CLONE_NEWUSER|…)` and the zygote's
> `clone(CLONE_NEWPID/NEWNET)`; `CAP_SYS_CHROOT` is kept for chroot. Probe run
> 41226712667 produced `LAUNCH_OK sandbox=true` **and** `PAGE_OK`; CI asserts
> `sandbox: true` and passes 9/9 E2E. See `docs/VERIFICATION_REPORT.md`.

**M11 — "Chromium cannot resolve names" is not enforced.**
`browser.ts:37-46` does not pass `--host-resolver-rules`, so Chromium still performs
DNS (prefetch/DoH) even though HTTP goes through the proxy. Also `net.ts:194-206`
rejects every IPv6 literal (URL.hostname keeps brackets, `normalizeHostname` returns
null), which is safe but over-blocks public IPv6, and the tool layer ignores the
configured allowed ports (`tools.ts:93` calls `checkUrl` with defaults). *Fix:* add
`--host-resolver-rules=MAP * ~NOTFOUND` and normalise bracketed IPv6 before
classification.

### Low

**L1 — robots.txt/TOS is not documented anywhere.** Requirement 09 says "documented
as an operator responsibility"; the only occurrence is the requirement file itself.

**L2 — SearXNG carries a Watchtower label.** `compose.yaml:163` contradicts "labels
for api/worker/web only".

**L3 — `/api/invitations/:token/preview` bypasses the state checks.**
`setup.ts:106-114` returns email/role/expiry for accepted, revoked and expired
tokens, unlike `/api/invitations/:token` (`:62-70`). The web UI does not call it.

**L4 — Redaction covers only the active API key.** `executor.ts:109,146,227,237`;
credentials embedded in provider `config.headers` are never added to `knownSecrets`.

**L5 — Dead report template.** `executor.ts:188-193` builds `reportToMarkdown(...)`
and discards it (`void markdown`), so the stored report, the export and the UI can
drift.

**L6 — Evidence counts in the docs drift.** Requirement 10 claims 7 egress tests
(there are 6); requirement 13 claims 15 UI tests (there are 21); the verification
report says 62 unit tests / 6 files (now 75 + 1 expected fail / 7 files).
`ollama.test.ts` also contains an `it.fails` that asserts the known mid-body
`TypeError` bug (`ollama.test.ts:229`) instead of fixing it.

**L7 — No CSV export.** Not claimed by requirement 12, but often assumed; only
`format=json|md` exist (`tasks.ts:398`).

---

## What I could not check statically

- **Integration behaviour** (`test/integration/**` was off-limits): cross-user IDOR,
  invitation races, TOTP, CSRF, quota and recovery are confirmed by reading code, not
  by running them. The Critical impersonation finding in particular needs a runtime
  proof.
- **Browser E2E**: `e2e/agent-tasks.spec.ts` exists but was not executed; all
  statements about the Playwright suite are about its content, not a green run.
- **Docker Compose**: no daemon here; images, seccomp profile, health checks and the
  Chromium sandbox were reviewed as configuration only.
- **Chromium sandbox / user namespaces**: depends on the kernel and container
  runtime; cannot be determined from the repository.
- **Live SMTP**: no SMTP server was available; the mailer's SMTP branch is unexercised.
- **Live Ollama / Codex / SearXNG / OpenAI-compatible**: the adapters were read and
  their fake servers inspected; no real endpoint was called.
- **DNS rebinding in a real browser**: the proxy is tested with an injected resolver,
  not with a real rebinding domain.
- **LLM-driven prompt injection**: requires a live model; only the prompt wrapping and
  tool allowlist were verified.
- **PostgreSQL error codes**: the 500-on-malformed-uuid finding is inferred from
  `app.ts`'s generic handler and drizzle's lack of uuid validation; not executed.
