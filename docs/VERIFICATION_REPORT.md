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
Chromium 1248 via Playwright 1.64.1. The host kernel does not provide user
namespaces, so Chromium's sandbox cannot start on the bare host.

## Executed gates (exact commands and results)

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | lockfile accepted | 0 |
| `pnpm lint` | 0 errors, 0 warnings | 0 |
| `pnpm -r typecheck` | 10 projects | 0 |
| `pnpm test:unit` | **153 passed**, 21 files | 0 |
| `TEST_DATABASE_URL=postgres://agent@127.0.0.1:55432/agent_tasks pnpm test:integration` | **48 passed**, 8 files, real PostgreSQL 15.15 | 0 |
| `pnpm --filter @agent-tasks/web test` | **34 passed**, 9 files | 0 |
| `pnpm --filter @agent-tasks/web build` | production bundle | 0 |
| `pnpm exec playwright test` (9 specs, real Chromium, real API/worker/runner, real PostgreSQL) | **9 passed** | 0 |
| `node apps/api/dist/index.js` + worker + runner (production bundles) | healthz OK, setup/login/session role verified | 0 |
| `node local Ollama 0.40.13 + llama3.2:1b` via `scripts/verify-ollama-local.ts` | real tool call `get_weather {city: "Vienna"}` | 0 |
| `docker compose config -q` | three app images + postgres + runner (+ search profile) | 0 |
| CI compose job (`Browser E2E`, GitHub run 41216069396) | stack started, web served, 9/9 Playwright tests passed (sandbox disabled on that kernel) | 0 |
| `docker compose build` | see "Docker Compose" below | — |
| `ratchet check` | 5 of 5 gates | 0 |
| GitHub Actions run 41221277339 (`1f805f4`) | **all 8 jobs success**: lint/typecheck, unit, integration, compose E2E, 3 image builds, security | 0 |
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
| 1 | pnpm monorepo, Apache-2.0, CI | `pnpm-workspace.yaml`, `apps/*`, `services/*`, `packages/*`, `LICENSE`, `.github/workflows/ci.yml` | `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm -r typecheck`; `LICENSE` present | PASS (local); CI run NOT VERIFIED until first push |
| 2 | Roles, invite-only onboarding, secure bootstrap | `apps/api/src/auth.ts`, `routes/setup.ts`, `routes/admin.ts` | `auth.test.ts`: setup token, single admin under concurrent setup, blocked direct sign-up, single-use invite under concurrency, revoked/expired invite | PASS |
| 2 | TOTP MFA, backup codes | `twoFactor()` plugin; `LoginPage` challenge; `SettingsPage` enable/disable | `auth.test.ts` (enable → verify → sign-in `twoFactorRedirect` → wrong code → valid code), `login-mfa.test.tsx` (4), `settings-mfa.test.tsx` (2) | PASS |
| 2 | Session revocation, CSRF, rate limits | `cookieCache.enabled=false`, origin hook in `app.ts`, `rateLimit.customRules` | `auth.test.ts` logout 401, CSRF 403, 429 | PASS |
| 2 | Audit log | `audit_logs`, `context.audit()` | `audit.test.ts`: setup, invite, role change, provider, credential; asserts the credential value never appears | PASS |
| 2 | Email reset/verification (HTML) | `mailer.ts`, `lib/email-templates.ts`, Better Auth senders | **Mailpit over real SMTP** (CI): multipart text+HTML, SpamAssassin score 0.6 (`IsSpam=false`); Mailpit HTML check **87.4 % supported, 1.55 % unsupported, 10 warnings**; Playwright renders the Mailpit UI, asserts heading/button/2 reset links and screenshots it. No external provider | PASS (SMTP + HTML compatibility via Mailpit) |
| 3 | Multi-user isolation / IDOR | owner-scoped queries, `requireUuid` | `isolation.test.ts` (8 tests: cross-user read/write/run/pause/cancel/export/history, forged owner id, credential isolation, admin bypass) | PASS |
| 4 | Task CRUD, presets, Europe/Vienna, DST | `packages/shared/src/schedule.ts`, `routes/tasks.ts` | `schedule.test.ts`: spring-forward 03:30, fall-back single booking, one-off past, summer/winter | PASS |
| 5 | Durable scheduling, no duplicates, leases, recovery | `apps/worker/src/scheduling.ts`, `queues.ts` | `scheduler.test.ts`: idempotent tick, concurrent ticks, DB duplicate rejection, single claim, stale-lease requeue/cancel | PASS |
| 5 | Retries, timeout, cancellation | `executor.ts`, `runtime.ts`, `quota.ts` | `execution.test.ts`; `runtime.test.ts` (deadline timeout vs caller cancel); `quota.test.ts` (N/N+1 boundaries); `lifecycle.test.ts` (graceful drain) | PASS |
| 5 | Parallel workers | `executionWorkOptions` → pg-boss `localConcurrency` | `queues.test.ts` (concurrency applied, 1 stays 1) | PASS (option) / PARTIAL (no multi-container run) |
| 6 | Ollama adapter, real model | `packages/ai-providers/src/ollama.ts` | **real Ollama 0.40.13 + llama3.2:1b**: `/api/show` reports `tools`, `chat()` returned `get_weather {"city":"Vienna"}` with usage 202 tokens (`scripts/verify-ollama-local.ts`, exit 0) | PASS |
| 6 | OpenAI-compatible / OpenCode Go contract | `openai-compatible.ts`, `packages/mock-openai`, `test/fixtures/opencode-go-server.ts` | 22 Go-conformance tests: SSE streaming, tool-call delta assembly, `[DONE]`, usage variants, `x-opencode-allowance`, stable `x-opencode-session`, honest UA, 401/402/403/429/5xx, malformed/truncated streams, abort, URL forms, `/models` fallback | PASS against the documented contract; real OpenCode Go account NOT VERIFIED |
| 6 | Codex, account-scoped only | `codex.ts`, per-user `CODEX_HOME` in `executor.ts`/`codex-home.ts` | unit tests (different owners → different 0700 homes, non-UUID refused, config not mutated); disabled unless `AGENT_TASKS_ENABLE_CODEX=1`; no real Codex account | PARTIAL / NOT VERIFIED (account) |
| 7 | Agent loop, validated tools | `packages/agent-runtime` | `runtime.test.ts` (tool execution, forbidden tool, untrusted wrapping, page/step limits, abort) | PASS |
| 7 | Real research, ≥3 pages, sources, report | `executor.ts`, `browser-runner` | `execution.test.ts`: deterministic fake SearXNG returned 3 URLs; real Chromium opened example.com/.org/.net; ≥3 distinct sources persisted, report markdown + usage recorded | PASS |
| 8 | Search backends | `packages/browser-tools/src/search.ts` | `search.test.ts` (6): SearXNG JSON mapping, non-http filtering, limit, HTTP 503, abort, fixture/noop | PASS |
| 9 | Browser isolation, egress policy | `docker/Dockerfile.runner`, `compose.yaml`, `proxy.ts`, `shared/src/net.ts` | `egress.test.ts` (7: loopback, private, DNS rebinding, port policy, IPv6 loopback/link-local, tunnel) + `net.test.ts` (18 classifications) | PASS (policy) |
| 9 | Chromium sandbox, non-root, read-only, no socket | compose: `RUNNER_CHROMIUM_SANDBOX=true` (env-overridable), non-root user, `read_only`, `cap_drop`, no docker socket | `docker inspect` + in-container checks: uid 1001, read-only, cap_drop ALL, no socket; loopback/private egress refused, public allowed; CI E2E runs research through the runner. **Sandbox itself: Chromium `No usable sandbox!` locally and in the GitHub runner container; CI runs with `RUNNER_CHROMIUM_SANDBOX=false`** | PASS (hardening/egress); **NOT VERIFIED (sandbox)** |
| 10 | Prompt injection, XSS, CSRF, secret leaks | runtime untrusted wrapper, `rehype-sanitize`, origin hook, `secretBox`, redaction | runtime tests; `markdown-safety.test.tsx`; `auth.test.ts` CSRF; `providers.test.ts` no secret in admin responses; `audit.test.ts`; ciphertext assertion | PASS |
| 11 | Reports/exports | `reportToMarkdown`, JSON/Markdown export routes | execution test persists report+sources; export routes covered in isolation tests | PASS (core) / PARTIAL (comparison view) |
| 12 | UI pages, i18n en/de, daisyUI | `apps/web` (React 19, Vite 8, Tailwind 4, daisyUI 5, Lingui 6) | 27 web tests (MFA, XSS, live de↔en switch), production build, 9 Playwright flows | PASS |
| 13 | Docker Compose deployment | `compose.yaml`, `docker/*`, `DEPLOYMENT.md` | local stack up (postgres/api/web/worker/runner healthy, setup+login+role in containers) and CI compose job starts the stack and runs 9/9 E2E | PASS |
| 14 | Unit/integration/E2E | `test/`, `packages/*/test`, `apps/*/test`, `e2e/` | 130 unit, 40 integration, 27 web, 9 E2E | PASS |
| 15 | GitHub Actions | `.github/workflows/ci.yml` | run 41218719813: lint/typecheck, unit, integration, compose E2E, api/web/runner image builds and security all success | PASS |
| 16 | Docs | README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, `.env.example`, `docs/` | files present; provider docs OpenAI-compatible-first | PASS |
| 17 | Publication | `all-the-rest/agent-tasks` (the brief's `Allderest` organisation does not exist) | `gh repo view`: PUBLIC, Apache-2.0, `main`; 14 issues; commit `7f76ca4` pushed; CI green | PASS (with the org deviation) |

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
- **Chromium sandbox:** with the shipped default `RUNNER_CHROMIUM_SANDBOX=true` the runner exits with Chromium's `FATAL … No usable sandbox!` on this host (kernel/AppArmor disables user namespaces). The compose file now supports the documented override (`RUNNER_CHROMIUM_SANDBOX=false`) and the local run used it. The sandbox itself is therefore **NOT VERIFIED on this host**; the default remains `true`. The Playwright suite now enables web research, so it exercises the compose runner and fails if the sandboxed default cannot start on the CI runner.
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
- **Running Compose stack**: verified locally and in CI (run 41218719813). CI disables the Chromium sandbox because the runner kernel refuses it.
- **Chromium sandbox inside the container**: `RUNNER_CHROMIUM_SANDBOX=true` fails with `No usable sandbox!` both on this host and in the GitHub runner container (no user namespaces). CI therefore runs with `false`; the production default stays `true`. This mandatory item is **NOT VERIFIED**.
- **External SMTP provider**: only Mailpit was available; delivery to a real internet mail provider (SPF/DKIM/DMARC) is still unverified.
- **GitHub Actions**: first run after the initial push.

## Repository

- URL: https://github.com/all-the-rest/agent-tasks (the brief's `Allderest/agent-tasks` does not exist; the `all-the-rest` organisation was used)
- Visibility: PUBLIC; License: Apache-2.0 (`LICENSE` present)
- Issues: 14 requirement issues (#1–#14)
- Commit: `1f805f4` (implementation + HTML mail + compatibility/UI verification) + the commit containing this report
- CI: run 41221277339 — all 8 jobs successful, including the Mailpit/SpamAssassin and UI checks

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

## Final verdict: NOT READY

Everything that can be proven in this environment is proven: real Ollama inference with a tool call, a contract-enforcing OpenAI-compatible/OpenCode-Go fixture, three-page real web research, multi-user isolation and IDOR tests, scheduling/DST/recovery, a running Compose stack, production bundles, and green local + GitHub CI gates.

The objective's READY gate is nevertheless not met, because mandatory items remain unproven:

1. **Chromium sandbox (mandatory).** It cannot start on this host or on the GitHub runner container (`No usable sandbox!`). The shipped default is `true`, but CI has to set `RUNNER_CHROMIUM_SANDBOX=false`; the sandbox has never been exercised successfully anywhere in this run.
2. **Real OpenCode Go account (mandatory provider path).** No account/API key was available. The adapter is verified only against a local HTTP fixture implementing the documented contract; real Go model ids, allowance values and rate-limit behaviour are unknown.
3. **Codex account-scoped execution.** No account was available; the adapter is opt-in and additionally refuses to run without an operator-provided isolated runner.

Additional deviations/gaps:

4. The organisation `Allderest` does not exist; the repository is public at `all-the-rest/agent-tasks`.
5. Real SMTP delivery (password reset, email verification) is unverified; no SMTP server was configured.
6. `fill_form` remains disabled by policy, so the model sees nine tools, not ten.

To reach READY, a host with unprivileged user namespaces (or a privileged sandbox sidecar) must run the shipped `RUNNER_CHROMIUM_SANDBOX=true` image successfully, and an OpenCode Go account must run one real streamed completion with a tool call. Both are environment/credential prerequisites, not code changes.
