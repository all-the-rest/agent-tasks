# Verification report

## OpenCode Go migration — 2026-11-03

**Decision: GO for the isolated runtime foundation; production cutover stays
gated.** Keep `OPENCODE_RUNTIME_ENABLED` unset or `0` until a real OpenCode Go
credential proves the remaining gates.

What is now implemented and tested:

- **Configuration.** The shared OpenCode Go connection and model catalog are
  written only through the admin API/UI. The `OPENCODE_GO_*` environment seed was
  removed; a fresh deployment starts with zero providers until an admin configures
  one. The admin provider card shows the discovered catalog and offers the official
  endpoint preset.
- **Isolation and egress.** `opencode` and `opencode-runtime` are internal
  networks; only the provisioner joins `opencode-egress`. The runtime is never
  published. The provisioner lifecycle smoke passes with fake credentials: private
  per-execution network/volumes, non-root runtime, owner-only secrets, session
  reuse after container recreation, cross-execution denial.
- **Recovery.** The durable message ID is persisted before dispatch. Recovery
  reads the finished assistant message first; otherwise it replays the same prompt
  ID and treats HTTP 409 as already accepted. A first dispatch rejected without a
  durable message fails closed. Steps are replaced by step number. Unit and
  integration tests cover replay, recovery, fail-closed and cancellation.
- **Tool bridge.** A worker-hosted MCP endpoint (JSON-RPC over SSE) exposes an
  explicit allowlist with a per-execution bearer token and call budget. The
  provisioner registers it and proxies `/mcp`. `compose_email` and
  `add_email_block` reuse the validated DSL/block schema and feed the execution
  result; the report page and report e-mail already render from that shape.

Still open before cutover:

1. A real OpenCode Go credential and live model/allowance validation.
2. A live Go run with research/sources and memory through the bridge under the
   production egress proxy and SSRF controls (the local OpenCode 2.2.5 run already
   retrieves and persists a source).
3. A full OpenCode Go run producing sources and usage end-to-end (the local
   OpenCode 2.2.5 run already produces e-mail blocks and a source via the bridge).
4. Shared-key rotation/revocation against the live provisioner.

Current verification for this change:

| Command | Result |
| --- | --- |
| `pnpm lint` | passed |
| `pnpm -r typecheck` | passed (10 workspace projects) |
| `pnpm test:unit` | **253 passed, 3 skipped**, 36 files passed / 1 skipped |
| `pnpm test:integration` | **85 passed**, 13 files |
| `OPENCODE_LIVE_TEST=1` (real OpenCode 2.2.5 + MCP bridge) | **3 passed**: final answer, `emailBlocks = [heading, paragraph]`, and a retrieved source persisted through the Executor |
| `services/opencode-provisioner` unit tests | **6 passed** |
| `scripts/verify-opencode-provisioner.mjs` in the rebuilt provisioner container | all lifecycle/isolation checks passed (fake credentials only) |
| `docker compose config -q` + `scripts/check-compose-parity.mjs` | passed |
| `ratchet check` | **11/11 gates passed** |

The opt-in live test starts a real OpenCode 2.2.5 process against a fake
OpenAI-compatible provider and the real worker MCP bridge. OpenCode offers
`agent_tasks_tools_compose_email` to the model, the model calls it, and the
execution result contains the validated heading and paragraph blocks. A second
live case opens a page through `agent_tasks_tools_open_url`; the Executor
persists the returned source row (`execution_sources`) and the report. A third
case exercises a PostgreSQL-backed Executor run. That is adapter evidence, not a
Go-account test. Never point the optional database test at production data; it
creates test records and pg-boss infrastructure.

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
| `pnpm test:unit` | **185 passed**, 26 files | 0 |
| `TEST_DATABASE_URL=postgres://agent@127.0.0.1:55432/agent_tasks pnpm test:integration` | **53 passed**, 9 files, real PostgreSQL 15.15 | 0 |
| `pnpm --filter @agent-tasks/web test` | **34 passed**, 9 files | 0 |
| `pnpm --filter @agent-tasks/web build` | production bundle | 0 |
| `pnpm exec playwright test` (9 specs, real Chromium, real API/worker/runner, real PostgreSQL) | **9 passed** | 0 |
| `node apps/api/dist/index.js` + worker + runner (production bundles) | healthz OK, setup/login/session role verified | 0 |
| `node local Ollama 0.40.13 + llama3.2:1b` via `scripts/verify-ollama-local.ts` | real tool call `get_weather {city: "Vienna"}` | 0 |
| `docker compose config -q` | three app images + postgres + runner (+ search profile) | 0 |
| `deployment/stack.sh {local,e2e,production} config -q` | projects `agent-tasks-local`, `agent-tasks-e2e`, `agent-tasks`; web ports 8090/8180/8080; volumes `agent-tasks-local_postgres-data`, `agent-tasks-e2e_postgres-data`, `agent-tasks_postgres-data`; local/E2E services labelled `com.agent-tasks.stack` (the production label was added in the 2026-11-02 follow-up and is checked by CI) | 0 |
| local + E2E stacks started together | `agent-tasks-local-web-1` on 8090 and `agent-tasks-e2e-web-1` on 8180, both `/api/healthz` → `{"ok":true}`; label filters returned only each stack's containers; `down -v` removed only its own volumes | 0 |
| CI compose job (`Browser E2E`, GitHub run 41235394232) | stack started with the sandbox **enabled**; runner `/healthz` asserts `sandbox: true`, `browserVersion 156.0.8078.4`; 9/9 Playwright tests passed | 0 |
| CI same job: env bootstrap and registration | `ADMIN_EMAIL` admin created, login as ADMIN, `403` without invitation, OpenCode Go provider + shared credential, enable → `200`, disable → `403` (`ENV_BOOTSTRAP_OK`) | 0 |
| CI same job: two workers and crash recovery | 6 concurrent executions, ≥2 distinct workers, one row each, duplicate `409`; SIGKILL of the owning worker → recovery on the survivor (`WORKERS_OK`) | 0 |
| Sandbox probe run 41226712667 (`2ce1ac8`) | exact production posture (pwuser; `cap_drop: ALL` + `cap_add: SYS_CHROOT`; `no-new-privileges`; custom seccomp): `LAUNCH_OK version=156.0.8078.4 sandbox=true` **and** `PAGE_OK text=ok` | 0 |
| `docker compose build` | see "Docker Compose" below | — |
| `ratchet check` | 11 of 11 gates (agent-rules preset + project rules) | 0 |
| GitHub Actions run 41222770419 (`97487c1`) | **all 8 jobs success**: lint/typecheck, unit, integration, compose E2E, 3 image builds, security | 0 |
| GitHub Actions run 41246589101 (`a473fac`) | **all 8 jobs success**: lint/typecheck incl. `Validate the deployment stacks` (local/E2E/production), unit, integration, compose E2E, 3 image builds, gitleaks/Trivy/audit | 0 |
| `scripts/check-mailpit.mjs` in CI (Mailpit + SpamAssassin) | reset mail via the shared builder: **spam score 0**, `IsSpam=false`; **HTML compatibility 85.6 % supported / 12.9 % partial / 1.55 % unsupported / 12 warnings** (thresholds 85/2/12) | 0 |
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

## Persistent memory (2026-11-01)

Persistent, editable memory is implemented in migration `0003_grey_landau.sql`,
the shared parser/budget module (`packages/shared/src/memory.ts`), the
transactional memory service (`packages/database/src/memory.ts`), owner-scoped
API routes (`apps/api/src/routes/memory.ts`), the worker's structured learning
step, and the Memory/Review UI. The agent can only emit validated
`record_task_memory` and `track_recommendation` operations; global memory is
written exclusively by authenticated user actions.

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm lint` | 0 errors, 0 warnings | 0 |
| `pnpm -r typecheck` | 10 workspace projects | 0 |
| `pnpm test:unit` | **210 passed**, 30 files (includes parser, duplicate/secret, budget, agent-tool, proxy and non-tool-model suites) | 0 |
| `TEST_DATABASE_URL=postgres://agent:agent@127.0.0.1:55432/agent_tasks pnpm test:integration` | **73 passed**, 11 files, real PostgreSQL | 0 |
| `pnpm --filter @agent-tasks/web test` | **34 passed**, 9 files | 0 |
| `pnpm --filter @agent-tasks/web build` | production bundle | 0 |
| `pnpm exec ratchet check` | 11 of 11 gates | 0 |
| `pnpm exec playwright test --list` | 11 specs discovered | 0 |
| Local Playwright run against API/worker/runner/Vite and the deterministic mock | **11/11 passed in 1.0 min** | 0 |

Memory-specific evidence:

- `test/integration/memory.test.ts` (16 tests): CRUD and revisions, re-login
  persistence, multi-user/cross-task isolation, slash-command parsing and
  scope errors, duplicate offer + `/update`, ambiguous update-prefix and
  ambiguous delete-search selection,
  search-then-confirm `/forget`, scoped forget, secrets, concurrent updates and
  duplicate creation, suggestion review including deletion of an
  accepted-suggestion memory (suggestion and journal content scrubbed),
  pending same-key and cross-key suggestions scrubbed through their journal
  rows, revision-wide tombstone blocking of pre-edit content, user-authoritative
  recommendation status, delete-all, task cascade and migration/restart
  persistence.
- `test/integration/memory-execution.test.ts` (4 tests): real `Executor` runs
  against the mock model. The first execution writes a task finding and a
  recommendation; the second receives both in its system prompt without creating
  duplicates; a user edit is preserved and blocks automatic overwrite; a deletion
  creates a tombstone and **two further runs** receive neither the deleted text
  nor a reconstructed memory (and each records a blocked tombstone attempt);
  `off` disables learning.
- `e2e/agent-tasks.spec.ts` adds three browser scenarios: `/learn` survives a new
  browser context; the next run shows the previous task memory and recognises the
  tracked recommendation exactly once; editing and deleting the task memory
  changes the next run's prompt and report. The suite is order-independent (one
  Playwright worker because the stack is shared): shared setup
  creates only the administrator/provider, each test owns its browser context and
  tasks, and a cleanup fixture removes tasks and global memories even on failure.
  The edit/delete scenario was also run alone (`--grep "edits and deletes a memory"`):
  **1/1 passed in 17.3 s**, so it does not depend on earlier tests.

Deletion is physical; `memory_revisions` cascade, the change journal is scrubbed
and the audit log carries ids/scope/category only. A content-free tombstone
(semantic key + SHA-256 hash) blocks automatic resurrection. Historical
execution reports and database backups are documented as a separate retention
domain in `docs/memory.md`.

## Published images and merged SPA (2026-11-01)

The production topology now uses **two** application images instead of three:

- `ghcr.io/all-the-rest/agent-tasks/api` — Fastify API **and** the built SPA, also
  used by the worker with `node apps/worker/dist/index.js`.
- `ghcr.io/all-the-rest/agent-tasks/browser-runner` — headless Chromium only.

The separate nginx/web image, `docker/Dockerfile.web` and `docker/nginx/` are
removed. `apps/api/src/static.ts` serves hashed assets, SPA navigations and the
same CSP/security headers; API paths keep their JSON 404. `WEB_ROOT` is an
explicit opt-in, so `pnpm dev` still uses Vite `:5173` with its `/api` proxy.

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm lint` | 0 errors | 0 |
| `pnpm -r typecheck` | 10 workspace projects | 0 |
| `pnpm test:unit` | **210 passed**, 30 files | 0 |
| `apps/api/test/static.test.ts` | production `WEB_ROOT` fail-fast, SPA navigation guard, dotfile refusal, shared CSP | 0 |
| `apps/api/test/http-policy.test.ts` | one-hop proxy trust and loopback-only health bypass | 0 |
| `services/browser-runner/test/egress.test.ts` | malformed proxy request answers 403 and the runner keeps serving | 0 |
| `TEST_DATABASE_URL=... pnpm test:integration` | **77 passed**, 12 files (4 SPA-serving tests) | 0 |
| `pnpm --filter @agent-tasks/web test` | **34 passed**, 9 files | 0 |
| `pnpm --filter @agent-tasks/web build` | production bundle | 0 |
| `pnpm exec ratchet check` | 11 of 11 gates | 0 |
| `test/integration/web.test.ts` | `/`, `/tasks/:id`, `/memory` serve index.html; `/api/*` and missing assets return JSON 404; `/assets/*` immutable + CSP; API 404 CSP equals the static CSP | 0 |
| final source-tree probe (`WEB_ROOT=apps/web/dist`, port 8087) | `/` and `/tasks/abc` 200 HTML + `Vary: Accept`; `/.env`, `/.git/config`, `/API/tasks` 404 JSON; traversal/malformed paths 403 `forbidden`; CSP byte-identical | 0 |
| `E2E_BASE_URL=http://localhost:8086 pnpm exec playwright test` (API-served SPA, no Vite/nginx) | **11/11 passed in 50.8 s** (pre-hardening API-served SPA run; the CI compose job is the release gate) | 0 |
| `docker build -f docker/Dockerfile.api` | **317 MB**; `/` HTML, SPA route HTML, `/api/nope` JSON 404, asset immutable cache | 0 |
| `docker build -f docker/Dockerfile.runner` | **1.71 GB** (vendor Playwright image was 3.99 GB); installs Chromium headless shell only | 0 |
| runner smoke with `cap_drop: ALL` + `SYS_CHROOT` + `docker/seccomp-browser.json` | `/healthz` → `{"ok":true,"sandbox":true,"browserVersion":"156.0.8078.4"}`; `open_url https://example.com` → `Example Domain` | 0 |
| `docker compose --env-file deployment/env/e2e.env config --services` | `browser-runner postgres worker api` (no `web`) | 0 |
| production config | API port published as `127.0.0.1:8080` (`HTTP_BIND`); runner/database/worker unpublished | 0 |

The release workflow `.github/workflows/release.yml` publishes the two images on
every `v*` tag with semantic, SHA and `latest` tags, then performs an anonymous
pull as the public-visibility gate.

Release run
[41309629877](https://github.com/all-the-rest/agent-tasks/actions/runs/41309629877)
(tag `v0.1.0`, commit `dcbc713`) built and pushed both images in CI:

| Image | Digest | Published tags |
| --- | --- | --- |
| `ghcr.io/all-the-rest/agent-tasks/api` | `sha256:c15a4cf2474b351a193c055fdc02939235978411146012ffd1a16e8bf5ad8bff` | `sha-dcbc713`, `latest`, `0`, `0.1`, `0.1.0` |
| `ghcr.io/all-the-rest/agent-tasks/browser-runner` | `sha256:784192606e0458b57ec6189e4eb57dbc2e9fae48bec56008eedf859fea398d9d` | `sha-dcbc713`, `latest`, `0`, `0.1`, `0.1.0` |

Both `Publish` jobs succeeded. After the two packages were made public, the
anonymous-pull gate was re-run (attempt 2) and the whole workflow is green:
`Verify anonymous pull` pulled `api:0.1.0` and `browser-runner:0.1.0` without
credentials. Direct anonymous manifest checks also return HTTP 200 for
`0`, `0.1`, `0.1.0` and `latest` on both packages.

Registry download size (amd64, compressed layers): **67.7 MB** for the API and
**462.8 MB** for the runner; the local uncompressed image sizes are **317 MB**
and **1.71 GB**. The runner previously used the ~4 GB vendor Playwright image.

Production pins the major line (`IMAGE_TAG=0`) so Watchtower follows compatible
`0.x` minor and bugfix releases without crossing a breaking major. The production
compose configuration validates and resolves the published `:0` images for api,
worker and browser-runner. **Production startup against the published images is
not verified in this run:** the operator chose to skip it after the remote Docker
daemon became unresponsive during the first registry pull. This remains an open
gate for that 2026-11-01 run; the owner-supplied host evidence from 2026-11-02
below closes the startup gate for the current production host, but not the
historical run itself.

### Deployment path (historical Portainer + Watchtower)

> **2026-11-02:** Portainer was removed from the production host. The stack now
> runs as the compose project `agent-tasks` in `/opt/stacks/agent-tasks` and is
> pushed from the repository by `deployment/deploy.sh`; see
> [DEPLOYMENT.md](../DEPLOYMENT.md#production-on-the-docker-host-optstacks). The
> notes below describe the verification run that predates the migration and are
> kept as evidence.

The production stack can be deployed from Portainer without committing a secret
environment file:

- `deployment/stack.sh` passes `deployment/env/<stack>.env` with `--env-file`;
  the `deployment/compose.*.yaml` overlays contain no `env_file`. The historical
  Portainer-style `docker compose -f deployment/compose.production.yaml config`
  with only `AUTH_SECRET`, `SECRETS_ENCRYPTION_KEY` and `RUNNER_TOKEN` passed at
  that time; the current production file additionally requires
  `POSTGRES_PASSWORD`, `PUBLIC_BASE_URL`, `COOKIE_SECURE` and `TRUST_PROXY`, and
  `deployment/stack.sh production` is now limited to local `config` validation.
- The production file (`deployment/compose.production.yaml`) sets
  `pull_policy: always` with `IMAGE_TAG=0`, so the host pulls the published GHCR
  images. The root `compose.yaml` instead pins `pull_policy: build` on api,
  worker and browser-runner, so a source checkout builds its own images.
- The manual Portainer web-editor path uses the root compose file. The runner
  needs `RUNNER_SECCOMP_PATH` pointing at `docker/seccomp-browser.json` on the
  Docker host; `SEARXNG_SETTINGS_PATH` does the same for the optional search
  profile. Seccomp is applied by the daemon before the container starts, so it
  cannot be supplied as a container environment variable; only its path can.
- CI run
  [41312348295](https://github.com/all-the-rest/agent-tasks/actions/runs/41312348295)
  is green: lint/typecheck (including all deployment-stack validation), unit,
  integration, browser E2E, both image builds and security scans.
- Documentation-only pushes do not start CI: `.github/workflows/ci.yml` ignores
  `**/*.md` and `docs/**`. Commits `90e60e7` and `3f08980` have
  `workflow_runs=0` in the GitHub Actions API. This commit is docs-only as well.

### Production host follow-up (2026-11-02)

Owner-supplied evidence from the live production host, recorded without reading
or printing any secret value:

| Check | Result |
| --- | --- |
| `docker compose config -q` in `/opt/stacks/agent-tasks` | exit 0 |
| `docker compose ps` | `api`, `browser-runner` and `postgres` healthy; `worker` running |
| `https://tasks.all-the.rest/` | HTTP 200 |
| `docker network inspect webnet` | subnet `172.18.0.0/16`, gateway `172.18.0.1` |
| `/opt/stacks/agent-tasks/.env` | owner/group `0:0`, mode `600`; values not read or printed |

Scope: this run proves the host stack starts and serves the application over
HTTPS with the core containers healthy. It did **not** execute a login/UI/auth
E2E flow, a redeploy, a rollback, or the optional `search` profile; those remain
unverified and are not claimed. The follow-up deploy preflight now fails closed on
a missing `webnet` or an IPAM entry that is not exactly `172.18.0.0/16` with
gateway `172.18.0.1`, an insecure host `.env`, an implicit `compose.override.*`
file or a host `.env` that sets `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`, effective
Compose-interpolated values that are empty/placeholders or use a
hostless/non-HTTPS `PUBLIC_BASE_URL`, a `RUNNER_TOKEN` missing from `worker` or
`browser-runner`, differing between them or reaching `api`, a rendered project
name other than `agent-tasks`, a rendered Postgres mount that is not the existing
`agent-tasks_postgres-data:/var/lib/postgresql/data`, an active `mail` profile,
and an active search profile without a real
host-only settings file. It also enforces strict SSH host-key checking, parses
the staged seccomp profile as JSON locally before transfer, pins every remote
Compose command to project `agent-tasks` and `/opt/stacks/agent-tasks/compose.yaml`,
and recreates only `browser-runner` when the staged seccomp bytes changed.
Local, non-host checks for this follow-up (no SSH, no deployment, no host
mutation):

| Command | Result |
| --- | --- |
| `bash -n deployment/deploy.sh` | exit 0 |
| `sh -n deployment/stack.sh` | exit 0 |
| `sh -n scripts/test-deploy-dry-run.sh` | exit 0 |
| `shellcheck -S warning deployment/deploy.sh deployment/stack.sh scripts/test-deploy-dry-run.sh .githooks/pre-commit` | exit 0 |
| `sh scripts/test-deploy-dry-run.sh` | OK: offline dry run; strict SSH/known_hosts handling; executed prereq/preflight/backup/promote bodies with stub docker/stat; valid env/network; bad `.env` mode; effective placeholder; hostless/non-HTTPS/malformed URL; `0.0.0.0/0` and wrong subnet; missing/placeholder search settings; RUNNER_TOKEN moved to api, missing from worker and mismatched between worker/runner; wrong project name; wrong Postgres volume source; active mail profile; override/`COMPOSE_FILE`/`COMPOSE_PROJECT_NAME` rejection; pinned Compose project/file on every remote call; DB backup success, empty-dump failure, stopped-postgres failure without confirmation, confirmed and first-deploy paths; promotion ordering (`.env` copy and `pg_dump` before `compose.yaml` promotion and `up`); unchanged/changed/missing seccomp recreation; invalid local seccomp JSON fails before transfer; `stack.sh production` accepts only `config` |
| `node scripts/check-deploy-compose-contract.mjs --fixture …` | exit 0: `RUNNER_TOKEN` on `worker` and `browser-runner` only and the fixture mounts `agent-tasks_postgres-data`; a fixture with the token moved to `api`, missing from `worker` or a different Postgres volume fails |
| `node scripts/test-compose-parity.mjs` | exit 0: mismatched named-volume source/mode and undocumented bind paths fail; privileged/user/network_mode/devices/sysctls/ulimits, volume external/driver/options and `backend.internal` mismatches fail; the documented SearXNG host bind is allowed by logical asset |
| `pnpm lint` | exit 0 |
| `pnpm -r typecheck` | exit 0 |
| `pnpm test:unit` | 213 passed, 30 files |
| `pnpm exec ratchet check` | 11 of 11 gates passed |
| `git diff --check` | exit 0 |
| `node scripts/check-compose-parity.mjs` | not run locally: this checkout has no Docker CLI; the CI lint job runs it and renders the real compose files |
| `docker compose config -q` with a dummy env | not run locally for the same reason; the generated-stack validation and parity checks are CI gates |

These local checks did **not** run Docker, Compose rendering, a live deploy, a
rollback or a production login/E2E flow. The remote backup/promotion bodies were
executed only against local stubs with temporary directories.

Production host operations were not run by the agent. The owner evidence above
is the only production evidence in this follow-up.

### Security review

Two independent subagents reviewed the release candidate before publication; both
returned **APPROVED** with no critical or high finding. The reviews covered the
SPA-serving code, auth/CSRF/rate-limit/X-Forwarded-For behavior, container
privileges, compose exposure, the runner sandbox and release-workflow supply
chain. The runtime review also probed the built images: traversal and dotfile
requests, unauthenticated API access, loopback/metadata `open_url` attempts,
capability and read-only posture, and malformed proxy requests.

Findings fixed before the tag (with regression tests):

- the runner's egress proxy crashed on a malformed absolute-form request because
  the error path parsed it with `new URL`; it now logs `unknown` and answers 403;
- `/api/healthz` bypassed the global limiter for every client; the bypass is now
  loopback-only, while a proxied/remote health request stays rate-limited;
- `TRUST_PROXY=true` trusted an entire forwarded chain; it now trusts exactly one
  proxy hop, so a client cannot rotate its rate-limit/audit address;
- static serving refused dotfiles and non-canonical paths without leaking files;
  malformed paths now return the documented `forbidden` JSON instead of `internal`;
- rate-limit rejections now return `rate_limited` without error-level stack logs;
- SPA fallback excludes dot-directories and case-insensitive `/api` paths;
- the SPA and API CSP headers come from one shared constant and are
  byte-identical; `Vary: Accept` marks the HTML/JSON variants;
- release actions are pinned to commit SHAs, workflow permissions are job-scoped,
  only numeric `v*` tags publish, and `latest` is skipped for prereleases.

Remaining accepted lows: Fastify's parser still answers a malformed URL with its
own 400 body; `COOKIE_SECURE` is an explicit operator setting (documented for
HTTPS); and the API image contains unserved source maps.

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
| 12 | UI pages, i18n en/de, daisyUI | `apps/web` (React 19, Vite 8, Tailwind 4, daisyUI 5, Lingui 6) | 34 web tests (MFA, XSS, live de↔en switch), production build, 11 Playwright flows (local memory run 11/11) | PASS |
| 13 | Docker Compose deployment | `compose.yaml`, `docker/*`, `deployment/`, `DEPLOYMENT.md` | local stack up (postgres/api/worker/runner healthy, setup+login+role in containers); CI compose job starts the stack and runs 9/9 E2E; local/E2E stacks render with distinct project names, host ports, volumes and `com.agent-tasks.stack` labels and ran at the same time; the production file declares the same label on every service and adds the external `webnet`; owner-supplied host evidence 2026-11-02: config valid, containers healthy, HTTPS 200 | PASS |
| 14 | Unit/integration/E2E | `test/`, `packages/*/test`, `apps/*/test`, `e2e/` | 210 unit, 77 integration, 34 web, 11 E2E (API-served SPA run) | PASS |
| 15 | GitHub Actions | `.github/workflows/ci.yml` | run 41235394232: lint/typecheck, unit, integration, compose E2E (sandbox, env bootstrap, two-worker/crash recovery, mail blocks/Mailpit), api/runner image builds and security all success | PASS |
| 16 | Docs | README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, `.env.example`, `docs/` | files present; provider docs OpenAI-compatible-first | PASS |
| 17 | Publication | `all-the-rest/agent-tasks` (the brief's `Allderest` organisation does not exist) | `gh repo view`: PUBLIC, Apache-2.0, `main`; 14 issues; commit `b7b79fa` pushed; CI green | PASS (with the org deviation) |
| 18 | Agent-composed e-mail blocks (image beside text) | `packages/shared/src/email-blocks.ts`, `packages/agent-runtime/src/tools.ts`, `apps/worker/src/executor.ts`, `apps/worker/src/mailer.ts` | `email-blocks.test.ts` (5): imageText left/right, escaping, http-only URLs, block cap, document; `tools.test.ts`/`runtime.test.ts`: `add_email_block` is offered only for e-mail notifications and returns the blocks; `compose_email` parses the compact DSL (`email-dsl.test.ts`, 5 tests) and is offered only for e-mail notifications; integration `execution.test.ts`: the mock model calls `compose_email` with a heading/paragraph/imageText DSL, the completion mail contains the image/text and the execution link, and the blocks are persisted in `report.email`; CI keeps the Mailpit check green with the shared builder | PASS |
| 19 | User-focused README with persistent screenshots | `README.md`, `docs/USER_GUIDE.md`, `docs/images/*.png`, `scripts/capture-readme-screenshots.mjs` | 10 committed PNGs captured from the running app (login, dashboard, tasks, task detail, execution report, settings, admin users/providers/settings/audit); README links the product tour and the user guide; `node scripts/capture-readme-screenshots.mjs` regenerates them | PASS |

## Docker Compose (executed)

`docker compose --env-file … --profile search up -d --build` started the real stack;
`docker compose ps` reported. This table is a historical run from before the SPA
was merged into the API image; the separate `web` container no longer exists in
the current compose files:

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
- **Running Compose stack**: verified locally and in CI (run 41235394232). The
  local host lacks unprivileged user namespaces, so the local stack used the
  documented override; CI runs the shipped `RUNNER_CHROMIUM_SANDBOX=true`
  posture and asserts it.
- **External SMTP provider**: only Mailpit was available; delivery to a real internet mail provider (SPF/DKIM/DMARC) is still unverified.
- **GitHub Actions**: first run after the initial push.

## Repository

- URL: https://github.com/all-the-rest/agent-tasks (the brief's `Allderest/agent-tasks` does not exist; the `all-the-rest` organisation was used)
- Visibility: PUBLIC; License: Apache-2.0 (`LICENSE` present)
- Issues: 14 requirement issues (#1–#14)
- Commit: `b7b79fa` (agent e-mail blocks, shared HTML builder, model variant suffix) + the commit containing this report
- CI: run 41235394232 — all 8 jobs successful, including Browser E2E with the sandbox, env bootstrap, two-worker/crash-recovery, mail blocks/Mailpit/SpamAssassin and UI checks

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

### Agent-composed e-mail blocks (added on request)

When a task is configured to notify by e-mail, the runtime offers the
`add_email_block` tool. The agent can add `heading`, `paragraph`, `image`,
`imageText`, `button` and `divider` blocks; `imageText` is the required
image-beside-text block. `emailBlockSchema` validates http(s)-only URLs and
lengths; `renderEmailBlocks`/`renderEmailDocument` in `packages/shared` produce
table-based inline-styled HTML plus a plain-text alternative. The worker sends
the completion mail with the execution link, and the transactional templates
use the same builder. A failed notification is logged and never fails the
execution.

Tests: five block-rendering tests, tool/runtime tests (the tool is offered only
when `notification=email`), and an end-to-end integration test in which the mock
model calls `add_email_block`, the executor stores `report.email.blocks`, and an
injected mailer receives HTML containing the image URL, alt text and body text.
E-mail compatibility continues to be measured in CI with Mailpit/SpamAssassin:
run 41235394232 (shared builder) reports spam score 0, 85.6 % supported,
1.55 % unsupported, 12 warnings and two reset links in the UI check.

The DSL is exposed to the model as the `compose_email` tool, with the grammar in
the tool schema and the system prompt; `parseEmailDsl` validates every block and
returns line-numbered errors that the model sees as the tool result. A second
end-to-end test drives the DSL through the mock model into the rendered mail.

### User guide and screenshots

`docs/USER_GUIDE.md` walks through sign-in, tasks, schedules, reports, e-mail
notifications and administration. The 10 screenshots under `docs/images/` were
captured against a seeded local instance with
`scripts/capture-readme-screenshots.mjs` and are committed, so the README and the
guide render on GitHub without external assets. The image references were
checked against the committed files; CI run 41235394232 keeps the full suite
green.

### Deployment stacks (added on request)

`deployment/` provides three entrypoints over the shared root `compose.yaml`:
production (`agent-tasks`), local (`agent-tasks-local`) and E2E
(`agent-tasks-e2e`). Local and E2E include the root compose file and carry their
own env file, so project name, networks, volumes and host ports are isolated;
production is the vendored host file and every service gets the label
`com.agent-tasks.stack=<stack>`. Local publishes web on 8090 and Mailpit on
1025/8025, E2E uses 8180 and 1126/8126, production keeps `HTTP_PORT` (default
8080). `deployment/stack.sh` generates the development secrets once and keeps the
`SETUP_TOKEN`/`E2E_SETUP_TOKEN` and `ADMIN_PASSWORD`/`E2E_ADMIN_PASSWORD` pairs
equal. In the 2026-11-02 follow-up, `stack.sh production` became local `config`
validation only; the host workflow is `deployment/deploy.sh`.

Executed: all three `config -q` variants exited 0; local and E2E were started at
the same time on the remote Docker daemon and answered `/api/healthz` with
`{"ok":true}` on 8090 and 8180; `docker ps --filter
label=com.agent-tasks.stack=local|e2e` returned only the matching containers;
`down -v` removed each project's own volumes. Because the daemon is remote,
the published ports were reached through `http://dind:<port>` here; on a normal
Docker host they are `http://localhost:<port>`. The CI lint job renders all
three stacks with `deployment/stack.sh <stack> config -q` before the E2E job
builds the stack. Run 41246589101 (`a473fac`) is the final proof: the three
validations, the Browser E2E job and the security scans all passed.

Gitleaks flagged the `replace-with-*` values in the production template as
generic API keys. The allowlist now accepts only a secret whose complete value
is a `replace-with-*` placeholder; a counter-test with a real high-entropy value
in the same file still produced a finding.

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
- No provider is seeded from the environment. The shared `OpenCode Go` connection
  is created through the admin API/UI and its key is encrypted at rest via
  `SECRETS_ENCRYPTION_KEY`; a deployment `.env` never contains an inference key.
- `.env.production` is a committed **local/single-host** template (no real
  secrets) with `ALLOW_REGISTRATION=false`, the admin bootstrap and OpenCode Go
  configuration; it is not the production host environment. The host uses
  `/opt/stacks/agent-tasks/.env` from `deployment/env/production.env.example`.
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
  **85.6 % supported, 12.9 % partial, 1.55 % unsupported, 12 warnings**
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

## Final verdict: READY for original scope; OpenCode foundation GO, cutover gated

The overall `READY` verdict covers the original Agent Tasks scheduler scope. The
OpenCode migration has a tested foundation (admin-only configuration, internal
networks with one egress exit, per-execution isolation, idempotent recovery,
worker-hosted MCP bridge) but its production cutover remains **gated** on a real
Go credential and the open items listed above. The original-scope
requirements are backed by executed evidence. The previously open
Chromium sandbox is proven end to end: probe run 41226712667 starts Chromium with
`sandbox=true` under the exact production posture (pwuser, `cap_drop: ALL` +
`cap_add: SYS_CHROOT`, `no-new-privileges`, the shipped seccomp profile) and
renders a page; CI run 41235394232 runs the Compose stack with
`RUNNER_CHROMIUM_SANDBOX=true`, asserts `sandbox: true` from the runner's
`/healthz` and passes all 9 Playwright E2E tests. The same job proves the
multi-worker path: two worker containers, six concurrent executions with
distinct claims, a refused duplicate trigger, and SIGKILL crash recovery on the
surviving worker. The agent-composed completion e-mail is covered by the shared
block builder and an end-to-end integration test; CI's Mailpit check reports
spam score 0 and 85.6 % HTML support with the same builder.

Remaining limits are non-mandatory or environment-scoped for the original
Agent Tasks scope, except for the separate OpenCode migration decision above:

1. **OpenCode Go cutover — gated** — no real Go account/API key was used. The
   OpenAI-compatible fake provider validates adapter behavior only; real Go auth,
   model/allowance behavior, the live egress/SSRF boundary and the
   production-image MCP run remain unverified. The admin-only configuration,
   isolation, recovery, MCP tool visibility (live 2.2.5), research/source
   retrieval, memory proposals and e-mail bridge are implemented and tested.
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
