# Verification report

Scope: the implementation in this repository against the original brief
("Agent Tasks — self-hosted AI task scheduler"). Every row names the code that
implements the requirement and the command/test that proves it. A row is `PASS`
only when the proof was executed in this session; everything else is `PARTIAL`,
`FAIL` or `NOT VERIFIED` with the reason.

Environment of this run (2026-10-31): Linux container, 4 cores, 7.8 GB RAM,
Node v26.10.0 on the host, pnpm 12.9.1, PostgreSQL 15.15 (installed locally for
this run), Docker 29.9.2 on a **remote daemon** (`tcp://dind:2375`; its state was
wiped during the session and it is intermittently unresponsive under host load).
Chromium 1248 via Playwright 1.64.1. The local developer container does not
provide user namespaces, so the local Compose stack used the documented
override; the shipped sandbox default is verified in CI (GitHub's Ubuntu 24.04
runner) against the exact production container posture.

## Executed gates (exact commands and results)

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | lockfile accepted | 0 |
| `pnpm lint` | 0 errors, 0 warnings | 0 |
| `pnpm -r typecheck` | 10 projects | 0 |
| `pnpm test:unit` | **170 passed**, 24 files | 0 |
| `TEST_DATABASE_URL=postgres://agent@127.0.0.1:55432/agent_tasks pnpm test:integration` | **52 passed**, 9 files, real PostgreSQL 15.15 | 0 |
| `pnpm --filter @agent-tasks/web test` | **34 passed**, 9 files | 0 |
| `pnpm --filter @agent-tasks/web build` | production bundle | 0 |
| `pnpm exec playwright test` (9 specs, real Chromium, real API/worker/runner, real PostgreSQL) | **9 passed** | 0 |
| `node apps/api/dist/index.js` + worker + runner (production bundles) | healthz OK, setup/login/session role verified | 0 |
| `node local Ollama 0.40.13 + llama3.2:1b` via `scripts/verify-ollama-local.ts` | real tool call `get_weather {city: "Vienna"}` | 0 |
| `docker compose config -q` | three app images + postgres + runner (+ search profile) | 0 |
| CI compose job (`Browser E2E`, GitHub run 41230606215) | stack started with the sandbox **enabled**; runner `/healthz` asserts `sandbox: true`, `browserVersion 156.0.8078.4`; 9/9 Playwright tests passed | 0 |
| CI same job: env bootstrap and registration | `ADMIN_EMAIL` admin created, login as ADMIN, `403` without invitation, OpenCode Go provider + shared credential, enable → `200`, disable → `403` (`ENV_BOOTSTRAP_OK`) | 0 |
| CI same job: two workers and crash recovery | 6 concurrent executions, ≥2 distinct workers, one row each, duplicate `409`; SIGKILL of the owning worker → recovery on the survivor (`WORKERS_OK`) | 0 |
| Sandbox probe run 41226712667 (`2ce1ac8`) | exact production posture (pwuser; `cap_drop: ALL` + `cap_add: SYS_CHROOT`; `no-new-privileges`; custom seccomp): `LAUNCH_OK version=156.0.8078.4 sandbox=true` **and** `PAGE_OK text=ok` | 0 |
| `docker compose build` | see "Docker Compose" below | — |
| `ratchet check` | 5 of 5 gates | 0 |
| GitHub Actions run 41222770419 (`97487c1`) | **all 8 jobs success**: lint/typecheck, unit, integration, compose E2E, 3 image builds, security | 0 |
| `scripts/check-mailpit.mjs` in CI (Mailpit + SpamAssassin) | reset mail: **spam score 0**, `IsSpam=false`; **HTML compatibility 87.4 % supported / 1.55 % unsupported / 10 warnings** | 0 |
| `scripts/verify-mail-ui.mjs` in CI (Playwright + Mailpit UI) | heading/paragraph/CTA/two reset links asserted; `mail-preview.png` artifact (112 kB) | 0 |

Reproduction:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm -r typecheck
pnpm test:unit
TEST_DATABASE_URL=postgres://agent:agent@localhost:55432/agent_tasks pnpm test:integration
pnpm --filter @agent-tasks/web test && pnpm --filter @agent-tasks/web build
E2E_BASE_URL=http://127.0.0.1:8099 E2E_SETUP_TOKEN=... pnpm exec playwright test
```

## Requirements

| # | Requirement | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- |
| 1 | pnpm monorepo, Apache-2.0, CI | `pnpm-workspace.yaml`, `apps/*`, `services/*`, `packages/*`, `LICENSE`, `.github/workflows/ci.yml` | `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm -r typecheck`; `LICENSE` present | PASS |
| 2 | Roles, invite-only onboarding, secure bootstrap | `apps/api/src/auth.ts`, `routes/setup.ts`, `routes/admin.ts`, `apps/api/src/bootstrap.ts` | `auth.test.ts`: setup token, single admin under concurrent setup, blocked direct sign-up, single-use invite under concurrency, revoked/expired invite. `bootstrap.test.ts`: first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (idempotent, role ADMIN), registration setting opens direct `USER` sign-up only when enabled | PASS |
| 2 | TOTP MFA, backup codes | `twoFactor()` plugin; `LoginPage` challenge; `SettingsPage` enable/disable | `auth.test.ts` (enable → verify → sign-in `twoFactorRedirect` → wrong code → valid code), `login-mfa.test.tsx` (4), `settings-mfa.test.tsx` (2) | PASS |
| 2 | Session revocation, CSRF, rate limits | `cookieCache.enabled=false`, origin hook in `app.ts`, `rateLimit.customRules` | `auth.test.ts` logout 401, CSRF 403, 429 | PASS |
| 2 | Audit log | `audit_logs`, `context.audit()` | `audit.test.ts`: setup, invite, role change, provider, credential; asserts the credential value never appears | PASS |
| 2 | Email reset/verification (HTML) | `mailer.ts`, `lib/email-templates.ts`, Better Auth senders | **Mailpit over real SMTP** (CI): multipart text+HTML, SpamAssassin score 0.6 (`IsSpam=false`); Mailpit HTML check **87.4 % supported, 1.55 % unsupported, 10 warnings**; Playwright renders the Mailpit UI, asserts heading/button/2 reset links and screenshots it. No external provider | PASS (SMTP + HTML compatibility via Mailpit) |
| 3 | Multi-user isolation / IDOR | owner-scoped queries, `requireUuid` | `isolation.test.ts` (8 tests: cross-user read/write/run/pause/cancel/export/history, forged owner id, credential isolation, admin bypass) | PASS |
| 4 | Task CRUD, presets, Europe/Vienna, DST | `packages/shared/src/schedule.ts`, `routes/tasks.ts` | `schedule.test.ts`: spring-forward 03:30, fall-back single booking, one-off past, summer/winter | PASS |
| 5 | Durable scheduling, no duplicates, leases, recovery | `apps/worker/src/scheduling.ts`, `queues.ts` | `scheduler.test.ts`: idempotent tick, concurrent ticks, DB duplicate rejection, single claim, stale-lease requeue/cancel | PASS |
| 5 | Retries, timeout, cancellation | `executor.ts`, `runtime.ts`, `quota.ts` | `execution.test.ts`; `runtime.test.ts` (deadline timeout vs caller cancel); `quota.test.ts` (N/N+1 boundaries); `lifecycle.test.ts` (graceful drain) | PASS |
| 5 | Parallel workers, duplicate prevention, crash recovery | `executionWorkOptions`, `claimExecution`, `recoverStaleExecutions`, the run guard in `routes/tasks.ts` | `queues.test.ts`, `scheduler.test.ts`; **CI run 41230606215**: two worker containers, six concurrent executions → ≥2 distinct `worker_id`s, exactly one row each, duplicate trigger `409`; SIGKILL of the owning worker → lease recovery completed the same execution on the survivor, one row | PASS |
| 6 | Ollama adapter, real model | `packages/ai-providers/src/ollama.ts` | **real Ollama 0.40.13 + llama3.2:1b**: `/api/show` reports `tools`, `chat()` returned `get_weather {"city":"Vienna"}` with usage 202 tokens (`scripts/verify-ollama-local.ts`, exit 0) | PASS |
| 6 | OpenAI-compatible / OpenCode Go contract | `openai-compatible.ts`, `packages/mock-openai`, `test/fixtures/opencode-go-server.ts` | Go-conformance tests incl. the two official headers: **tool User-Agent (non-generic) and stable `x-opencode-session` on chat, `/models` and health**; spoofed extra headers cannot replace them; empty session refused; schema rejects generic agents. Plus SSE streaming, tool deltas, allowance, error mapping | PASS against the contract-enforcing fake API (operator-accepted); real account NOT VERIFIED |
| 6 | Codex, account-scoped only | `codex.ts`, per-user `CODEX_HOME` in `executor.ts`/`codex-home.ts` | unit tests (different owners → different 0700 homes, non-UUID refused, config not mutated); disabled unless `AGENT_TASKS_ENABLE_CODEX=1`; no real Codex account | PARTIAL / NOT VERIFIED (account) |
| 7 | Agent loop, validated tools | `packages/agent-runtime` | `runtime.test.ts` (tool execution, forbidden tool, untrusted wrapping, page/step limits, abort) | PASS |
| 7 | Real research, ≥3 pages, sources, report | `executor.ts`, `browser-runner` | `execution.test.ts`: deterministic fake SearXNG returned 3 URLs; real Chromium opened example.com/.org/.net; ≥3 distinct sources persisted, report markdown + usage recorded | PASS |
| 8 | Search backends | `packages/browser-tools/src/search.ts` | `search.test.ts` (6): SearXNG JSON mapping, non-http filtering, limit, HTTP 503, abort, fixture/noop | PASS |
| 9 | Browser isolation, egress policy | `docker/Dockerfile.runner`, `compose.yaml`, `proxy.ts`, `shared/src/net.ts` | `egress.test.ts` (7: loopback, private, DNS rebinding, port policy, IPv6 loopback/link-local, tunnel) + `net.test.ts` (18 classifications) | PASS (policy) |
| 9 | Chromium sandbox, non-root, read-only, no socket | `compose.yaml` (`RUNNER_CHROMIUM_SANDBOX=true`, `cap_drop: ALL` + `cap_add: SYS_CHROOT`, custom seccomp), `docker/seccomp-browser.json`, `browser.ts` | Probe run 41226712667: **`LAUNCH_OK sandbox=true` + `PAGE_OK`** with pwuser, no SYS_ADMIN, `no-new-privileges`, read-only, the custom profile; CI asserts `/healthz` `sandbox: true` and passes 9/9 E2E; `docker inspect`: uid 1001, read-only, no socket; loopback/private egress refused | PASS |
| 10 | Prompt injection, XSS, CSRF, secret leaks | runtime untrusted wrapper, `rehype-sanitize`, origin hook, `secretBox`, redaction | runtime tests; `markdown-safety.test.tsx`; `auth.test.ts` CSRF; `providers.test.ts` no secret in admin responses; `audit.test.ts`; ciphertext assertion | PASS |
| 11 | Reports/exports | `reportToMarkdown`, JSON/Markdown export routes | execution test persists report+sources; export routes covered in isolation tests | PASS (core) / PARTIAL (comparison view) |
| 12 | UI pages, i18n en/de, daisyUI | `apps/web` (React 19, Vite 8, Tailwind 4, daisyUI 5, Lingui 6) | 27 web tests (MFA, XSS, live de↔en switch), production build, 9 Playwright flows | PASS |
| 13 | Docker Compose deployment | `compose.yaml`, `docker/*`, `DEPLOYMENT.md` | local stack up (postgres/api/web/worker/runner healthy, setup+login+role in containers) and CI compose job starts the stack and runs 9/9 E2E | PASS |
| 14 | Unit/integration/E2E | `test/`, `packages/*/test`, `apps/*/test`, `e2e/` | 164 unit, 48 integration, 34 web, 9 E2E | PASS |
| 15 | GitHub Actions | `.github/workflows/ci.yml` | run 41230606215: lint/typecheck, unit, integration, compose E2E (sandbox, env bootstrap, two-worker/crash recovery), api/web/runner image builds and security all success | PASS |
| 16 | Docs | README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, `.env.example`, `docs/` | files present; provider docs OpenAI-compatible-first | PASS |
| 17 | Publication | `all-the-rest/agent-tasks` (the brief's `Allderest` organisation does not exist) | `gh repo view`: PUBLIC, Apache-2.0, `main`; 14 issues; commit `0a03590` pushed; CI green | PASS (with the org deviation) |

## Docker Compose (executed)

`docker compose --env-file … --profile search up -d --build` started the real stack;
`docker compose ps` reported:

| Service | Status |
| --- | --- |
| postgres | Up (healthy) |
| api | Up (healthy) |
| web | Up, `GET /` → 200 |
| worker | Up (`worker_started`, concurrency 1) |
| browser-runner | Up (healthy) with `RUNNER_CHROMIUM_SANDBOX=false` for this kernel |
| searxng (profile `search`) | Up |

Verified against the running containers:

- **Containerised bootstrap:** `POST /api/setup` → 200, sign-in → 200, `/api/me` → 200 with `role: ADMIN`, `/api/auth/get-session` contains `role`.
- **Runner hardening** (`docker inspect`): `User=pwuser` (uid 1001), `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`, custom seccomp profile, no published ports, no `/var/run/docker.sock`. The process is `uid=1001(pwuser)`.
- **Egress inside the container:** `open_url http://127.0.0.1:8081/healthz` → `{"ok":false,"error":"port 8081 is not allowed"}`; `http://10.0.0.1/` → `{"ok":false,"error":"address 10.0.0.1 is not public"}`; `https://example.com/` → `{"ok":true}`. Session cleanup returned `sessions: 0`.
- **Chromium sandbox:** the runner now starts with the sandbox enabled. Three
  container-level pieces are required and regression-tested: the seccomp profile
  must allow `unshare(CLONE_NEWUSER)`, the combined
  `clone(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET)` launch, and the zygote's
  renderer fork (`clone(CLONE_NEWPID)`/`CLONE_NEWNET`); the container must keep
  `CAP_SYS_CHROOT` for the sandbox's chroot. The exact posture (pwuser,
  `cap_drop: ALL` + `cap_add: SYS_CHROOT`, `no-new-privileges`, custom seccomp)
  produced `LAUNCH_OK sandbox=true` and `PAGE_OK` in probe run 41226712667; CI
  asserts `sandbox: true` from `/healthz`. This developer host still lacks
  unprivileged user namespaces (kernel policy), so its local Compose run used
  the documented `RUNNER_CHROMIUM_SANDBOX=false` override; the shipped default
  stays `true` and is proven in CI.
- **Real bug found and fixed:** the runtime images copied workspace packages as TypeScript sources while the app bundles externalised them, so api/worker/runner crashed with `ERR_MODULE_NOT_FOUND … packages/database/src/client.js`. Fixed with `noExternal: [/^@agent-tasks\//]` tsup configs; the production bundles were then run directly against real PostgreSQL and passed the same bootstrap/login flow.
- **Web image bug found and fixed:** nginx-unprivileged runs as uid 101, so `RUN rm -f /docker-entrypoint.d/…` failed with permission denied; the Dockerfile now removes it as root and switches back.

## Findings (by severity)

### Critical (found and fixed in this session)

1. **Runtime images could not start.** Workspace packages are source-only (`main` → `src/index.ts`), but tsup externalised them; every container died at module load. Fixed by bundling `@agent-tasks/*` into the app bundles (`apps/api/tsup.config.ts`, `apps/worker/tsup.config.ts`, `services/browser-runner/tsup.config.ts`); verified by running all three `dist` entrypoints against real PostgreSQL.
2. **Admin-plugin bypass.** Better Auth's `admin()` plugin exposed `/api/auth/admin/*` (impersonation, set-role, ban, create-user) outside our audit and last-admin guards. Plugin removed; impersonated sessions are rejected; banned users are refused at session creation; `/api/auth/two-factor/*` remains. Regression tests added.
3. **Admin UI lockout after that removal.** `get-session` no longer carried `role`, so `RequireAdmin` redirected admins. Fixed with `user.additionalFields.role`; E2E test 8 now passes.

### High

4. **Invitation races.** Accept/registration did SELECT-then-write; a token could be redeemed twice and the auth bridge never set `accepted_at`. Replaced with one conditional `UPDATE … RETURNING` claim plus release on failure; concurrent-accept test asserts exactly one success.
5. **Concurrent setup could create two admins.** Serialised with a transaction-scoped advisory lock and re-check; concurrent test asserts one 200, one 409, one admin.
6. **i18n interpolation broken.** Catalogs used mustache placeholders (`{{email}}`) and were never compiled, so the UI rendered raw placeholders and E2E failed. Converted to ICU (`{email}`) and enabled Lingui's runtime compiler; E2E invitation flow passes.
7. **Timeout retried as transient.** A deadline abort surfaced as `ProviderError('timeout')` and was retried, making `timed_out` unreachable. The runtime now remembers the abort reason and throws `AgentCancelledError('timeout')`; executor maps it to `timed_out` without retry. Unit tests cover deadline vs caller signal.
8. **`WORKER_CONCURRENCY` ignored.** Applied through pg-boss v12 `localConcurrency`; tests pin it.
9. **Provider secrets echoed.** Admin provider responses returned raw `config.headers`. Redacted to an allowlist with `***` header values; integration test asserts no `Bearer`/secret appears.
10. **Shared credential upsert never conflicted** (`owner_id NULL`); replaced with a locked read-then-update transaction.
11. **Malformed provider/invitation ids could 500.** `requireUuid` now precedes DB access; tests across all provider routes.
12. **Codex was unconfigurable** (`enabled`/`codexHome` stripped) and shared one global home. Added `codexConfigSchema`, per-user `CODEX_HOME_ROOT/<owner-uuid>` with 0700 creation, and validation against path traversal.

### Sandbox verification (fixed in this session)

The first probe was invalid: the Playwright image ships browsers but no
`playwright` package, so it never launched anything. The shipped profile then
had three gaps, each fixed and covered by
`services/browser-runner/test/seccomp-profile.test.ts`:

1. `SCMP_CMP_MASKED_EQ` compares `(arg & value)` against `valueTwo`, which
   defaults to 0; the first `unshare(CLONE_NEWUSER)` rule was inverted and
   denied exactly that call.
2. Docker resolves cap-conditional rules at container start. `chroot` is only
   allowed with `CAP_SYS_CHROOT`, which `cap_drop: ALL` removed; the container
   now adds `CAP_SYS_CHROOT` back (still no `SYS_ADMIN`).
3. The zygote forks renderers with `clone(CLONE_NEWPID)`/`CLONE_NEWNET` after
   the user namespace exists; the profile only allowed `CLONE_NEWUSER`, so
   `newContext` hung with "Zygote could not fork". Both flags are allowed now;
   the kernel still enforces the capability check.

Probe run 41226712667 launched **and rendered a page** under the exact posture;
CI run 41230606215 asserts `sandbox: true` and passes the E2E suite.

### Medium

13. **Ollama truncated-body bug.** `response.json()` outside try/catch leaked a raw `TypeError` on a mid-body disconnect. Now typed `unavailable`; the previously expected-fail test is a normal passing test.
14. **Lockfile/pnpm mismatch.** `packageManager` triggered pnpm self-management inside the image, so `--frozen-lockfile` failed there while passing locally. Replaced with `engines.pnpm` (`>=12.9.1 <13`); image installs pass.
15. **Compose startup traps.** `SETUP_TOKEN: ""` crash-looped the API; now `${SETUP_TOKEN:?…}`. Added the Codex volume; removed the inert `SEARXNG_SECRET` env (the mounted settings file pins the key).
16. **MFA web flow.** `twoFactorRedirect` was ignored and no TOTP/backup-code UI existed; implemented login challenge plus enable/disable in Settings (27 web tests).
17. **Task form reset race** (typed input wiped when `/api/me` resolves) — worked around in E2E; still a low-severity UI defect.

### Low

18. Web bundle is one large chunk; no route splitting.
19. Runner `BrowserContext` isolation is not an OS boundary (documented).
20. Integration tests share one database and must not run in parallel.

### Independent review round (before the first push)

An independent reviewer read the whole unpushed range and returned CHANGES REQUIRED. The following were fixed and covered by tests in the same commit:

- **Partial PATCH reset create defaults.** `taskUpdateSchema`/`userPreferencesUpdateSchema` stripped Zod defaults from omitted keys; a title-only PATCH no longer resumes a paused task, re-enables research or resets limits, and `nextRunAt` is recomputed only when `schedule`/`enabled` change.
- **Queued executions could be orphaned.** A failed `boss.send` left a `queued` row with no job. A paginated sweep in the recovery job (and at boot) re-sends stale queued rows; sends bump `updated_at` so a failed send is retried on the next sweep.
- **Codex is not an isolation boundary.** Because `codex exec` can run commands in the worker namespace and per-user homes are only a path convention, the worker refuses Codex unless `CODEX_ISOLATED_RUNNER=1` (operator-provided isolation). Per-user directories are derived by hashing any Better Auth id, not by requiring a UUID.
- **Context truncation could drop the system prompt** and split tool-call/result pairs; the runtime now trims whole turns and keeps the system message. Page visits count repeated URLs and clicks/back navigation; output caps apply to all text-returning tools.
- **Egress bypass.** Chromium now uses `--proxy-bypass-list=<-loopback>`, resolver pinning and `disable_non_proxied_udp`; the in-container test still refuses loopback and RFC1918.
- **Admin invite deletion with a malformed id** returned 500; now `requireUuid` → 404.
- **Invalid provider config** returned 500; now 400 via `safeParse`.
- **Last-admin race** serialised with an advisory lock and a concurrent-demotion test.
- **Setup partial failure** could permanently lock the instance; the created user is removed on failure and setup status counts admins.
- **Invitation tokens in request logs** are masked in the pino request serializer and in the nginx access-log format (`/invite/***`, `/api/invitations/***`).
- **Redacted provider headers** are preserved when the admin UI PATCHes `***` back.
- **Health endpoint** now executes `SELECT 1` instead of reporting healthy without PostgreSQL.
- **CI** gained Playwright browser installation for the integration job, the web test suite and `ratchet check`; the E2E mock binds `0.0.0.0` and uses the Docker gateway URL so the task/execution test cannot silently skip.
- **Compose** gained `/tmp` tmpfs for the read-only web container, `TRUST_PROXY=true` behind nginx, a 40 s worker stop grace, a longer runner session TTL and the Codex volume/env forwarding; the Chromium sandbox is configurable and stays `true` by default.
- **ngeo/nginx** image now removes the IPv6 entrypoint script as root before switching back to uid 101.

## Not verified in this run — and why

- **OpenCode Go with a real account**: no account/API key available. The adapter is proven against a real HTTP fixture that enforces the documented contract; model ids, allowance values and rate-limit headers of the real service remain unknown.
- **Codex with a real account**: none available; adapter is opt-in and text-only.
- **Running Compose stack**: verified locally and in CI (run 41230606215). The
  local host lacks unprivileged user namespaces, so the local stack used the
  documented override; CI runs the shipped `RUNNER_CHROMIUM_SANDBOX=true`
  posture and asserts it.
- **External SMTP provider**: only Mailpit was available; delivery to a real internet mail provider (SPF/DKIM/DMARC) is still unverified.
- **GitHub Actions**: first run after the initial push.

## Repository

- URL: https://github.com/all-the-rest/agent-tasks (the brief's `Allderest/agent-tasks` does not exist; the `all-the-rest` organisation was used)
- Visibility: PUBLIC; License: Apache-2.0 (`LICENSE` present)
- Issues: 14 requirement issues (#1–#14)
- Commit: `0a03590` (env bootstrap, registration setting, OpenCode Go seed, worker verification) + the commit containing this report
- CI: run 41230606215 — all 8 jobs successful, including Browser E2E with the sandbox, env bootstrap, two-worker/crash-recovery, Mailpit/SpamAssassin and UI checks

### OpenCode Go client contract (operator acceptance: fake API)

The official requirements are: a client-specific `User-Agent` (never a generic SDK)
and a stable `x-opencode-session` per conversation, including auxiliary requests.
`buildHeaders()` now makes both headers win over arbitrary `config.headers`; an
empty session id is a typed error; `compatibleConfigSchema` rejects generic agents
and an empty session header. Tests assert both headers on chat, `/models` and
health, stable/distinct sessions, spoof resistance, and the schema rules. The
contract-enforcing fake API is accepted by the operator for this goal; real-account
values remain unknown.

The Playwright image **alone** does not enable the sandbox: it ships browsers but
no `playwright` npm package, its `chrome_sandbox` is mode `0777` (not setuid) and
it runs as root by default. The container needed three additional settings, now
shipped and covered by regression tests: seccomp rules for
`unshare(CLONE_NEWUSER)`, `clone(CLONE_NEWUSER|…)` and the zygote's
`clone(CLONE_NEWPID/NEWNET)`, plus `CAP_SYS_CHROOT`. Probe run 41226712667 shows
`LAUNCH_OK sandbox=true` **and** `PAGE_OK` with the exact production posture.

### Parallel workers and crash recovery (practical)

The compose E2E job scales the worker service to two containers and runs
`scripts/verify-workers.mjs`:

- six concurrent manual runs of separate tasks against a slow mock inside the
  compose network (one model call, 20 s latency);
- asserts at least two distinct `worker_id`s, exactly one execution row per run
  and a `409` when an already active task is triggered again;
- reads the `worker_id` of a running execution, maps it to the owning container,
  SIGKILLs that container (`docker update --restart=no` + `docker kill`) and
  waits for the 120 s lease plus the 2-minute recovery tick: the same execution
  row is requeued and completes on the surviving worker, with no duplicate row.

Run 41230606215: `worker-df7551c0` was killed mid-run, `worker-c73ef3f2`
completed the recovered execution, and the script printed `WORKERS_OK`. The
surrounding Playwright suite passed 9/9 in the same run.

### Registration setting and environment bootstrap (added on request)

- `ALLOW_REGISTRATION` (`false` by default) seeds the database setting on a fresh
  database; the admin UI can change it later and the env value never overwrites a
  saved setting. When on, `/register` and `POST /api/auth/sign-up/email` create a
  `USER` account without an invitation; when off, sign-up still requires a
  single-use invitation (403 otherwise). The bridge in `app.ts` enforces this, so
  the UI is not the boundary.
- `ADMIN_EMAIL`/`ADMIN_PASSWORD` (both or neither, password ≥ 12) create the first
  administrator on start when no admin exists; `SETUP_TOKEN` remains the fallback.
  The seed runs under an advisory lock, is idempotent and compensates a failed
  transaction.
- `OPENCODE_GO_API_KEY` (+ `OPENCODE_GO_MODEL`/`OPENCODE_GO_MODELS`) seeds the
  `OpenCode Go` provider once, with the key encrypted at rest via
  `SECRETS_ENCRYPTION_KEY`; it never updates an existing provider.
- `.env.production` is a committed template (no real secrets) with
  `ALLOW_REGISTRATION=false`, the admin bootstrap and OpenCode Go configuration;
  start it with `docker compose --env-file .env.production up -d`.
- Tests: `apps/api/test/env.test.ts` (5) and `test/integration/bootstrap.test.ts`
  (4, including the runtime toggle).
- CI run 41230606215 starts the compose stack with `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  and a seeded OpenCode Go provider; `scripts/verify-env-bootstrap.mjs` asserts
  `setup/status` configured, the `403` without invitation, login as `ADMIN`, the
  provider with a shared credential, enable → `200` and disable → `403`
  (`ENV_BOOTSTRAP_OK`). The local developer Docker daemon was unresponsive
  during this check, so the runtime proof is from CI.

### Transactional mail (added after the first verification)

- Functional mails (password reset, address verification, invitation) are now
  multipart/alternative: a plain-text part plus an inline-styled HTML document.
  Every interpolated value is escaped; the server-generated action URL is the only
  href.
- The optional compose profile `mail` runs Mailpit with a SpamAssassin sidecar.
  CI requests a real reset, fetches the message through Mailpit's API and queries
  `GET /api/v1/message/{id}/sa-check`: **score 0 / 0.6 across runs, `IsSpam=false`** (threshold 5).
  This is SpamAssassin's score as surfaced by Mailpit, not a Mailpit-only heuristic.
- **HTML compatibility** is measured with Mailpit's HTML check (caniemail data):
  **87.4 % supported, 11.0 % partial, 1.55 % unsupported, 10 warnings**
  (186 tests, 21 nodes). The main unsupported shares are the `<body>` element
  (32.7 % of that one finding) and underlined-link `text-decoration` (6.3 %);
  table layout, inline CSS, `bgcolor` fallbacks and the action link are broadly
  supported. Thresholds in CI: supported ≥ 85 %, unsupported ≤ 2 %, warnings ≤ 12.
- **UI verification**: `scripts/verify-mail-ui.mjs` opens the message in the
  Mailpit UI with Playwright, asserts the heading, paragraph, CTA button and two
  reset links, and uploads `mail-preview.png`. The UI reported
  "HTML Check 87%"; the artifact shows the rendered reset mail with button and
  fallback link.
- Unit tests cover the renderer, multipart content and HTML escaping.

## Final verdict: READY

All mandatory requirements are backed by executed evidence. The previously open
Chromium sandbox is proven end to end: probe run 41226712667 starts Chromium with
`sandbox=true` under the exact production posture (pwuser, `cap_drop: ALL` +
`cap_add: SYS_CHROOT`, `no-new-privileges`, the shipped seccomp profile) and
renders a page; CI run 41230606215 runs the Compose stack with
`RUNNER_CHROMIUM_SANDBOX=true`, asserts `sandbox: true` from the runner's
`/healthz` and passes all 9 Playwright E2E tests. The same job proves the
multi-worker path: two worker containers, six concurrent executions with
distinct claims, a refused duplicate trigger, and SIGKILL crash recovery on the
surviving worker.

Remaining limits are non-mandatory or environment-scoped:

1. **OpenCode Go with a real account** — by operator decision the
   contract-enforcing fake API is sufficient; live model ids and allowance
   values remain unknown. The two mandatory client headers (tool User-Agent,
   stable `x-opencode-session`) are enforced and tested.
2. **Codex account-scoped execution** — optional and experimental, disabled by
   default, no account available.
3. **Real internet SMTP delivery** — Mailpit + SpamAssassin only; SPF/DKIM/DMARC
   remain unverified.
4. **Repository organisation** — `Allderest` does not exist; the public repo is
   `all-the-rest/agent-tasks`.
5. **`fill_form`** — disabled by policy; the model sees nine tools, not ten.
6. **Local developer host** — its kernel forbids unprivileged user namespaces,
   so the local Compose run used the documented `RUNNER_CHROMIUM_SANDBOX=false`
   override; the shipped default is proven in CI.
