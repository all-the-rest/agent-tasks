# Changelog

## 0.1.0 — unreleased

### Added

- Persistent, editable AI memory: global user memory and per-task memory with
  PostgreSQL full-text search, revisions, provenance, provenance-safe deletion
  tombstones, export, slash commands (`/learn`, `/memory`, `/update`, `/forget`),
  deterministic duplicate detection, automatic task learning (`off`/`suggest`/
  `auto`), structured recommendations with status history, and Memory/Review UI.
- pnpm monorepo: web, api, worker, browser runner, shared/database/provider/agent packages.
- Better Auth authentication: invite-only onboarding, secure first-admin bootstrap,
  session revocation, TOTP MFA, rate limiting, password reset and verification mail.
- ADMIN/USER roles enforced server-side, audit log for sensitive operations.
- Tasks: CRUD, pause/resume, run-now, duplicate, limits, presets and custom cron,
  IANA timezones with DST handling.
- Scheduler and execution on pg-boss with transactional booking, leases, retries,
  cancellation, timeouts, crash recovery and per-user quotas.
- Agent runtime with ten validated tools, untrusted-content handling and hard limits.
- OpenAI-compatible providers; legacy Ollama adapter; mock OpenAI-compatible server for tests.
- Hardened Playwright browser service with an enforcing egress proxy.
- React UI with English/German catalogues on Lingui 6 (gettext PO files).
- Docker Compose deployment with hardened containers and Watchtower labels. The
  Portainer stack path is historical; production now runs as the host-managed
  compose project `agent-tasks` in `/opt/stacks/agent-tasks`.
- Version tags publish public `ghcr.io/all-the-rest/agent-tasks/{api,browser-runner}`
  images with semantic, SHA and `latest` tags. The API image also serves the built
  SPA, so there is no separate web container; the API port binds to loopback for a
  global TLS proxy. Production pulls version tags instead of building; use the
  `sha-*` tag when a deployment needs one fixed build.
- Isolated production, local and E2E stacks under `deployment/` with distinct
  project names, ports, volumes and `com.agent-tasks.stack` labels, so local and
  E2E run simultaneously.
- GitHub Actions CI with lint, typecheck, tests, image builds, Trivy, gitleaks and a production-dependency audit.
- Host deployment safety: `deployment/deploy.sh` requires an explicit
  `DEPLOY_HOST`, validates the seccomp profile as JSON locally, stages and
  promotes it, validates the *effective* Compose-interpolated `.env` values
  through `docker compose config` (never raw `KEY=` tails) without printing them,
  requires the rendered Postgres mount to be exactly
  `agent-tasks_postgres-data:/var/lib/postgresql/data`, requires `webnet` to be
  exactly `172.18.0.0/16` gateway `172.18.0.1`, rejects an active `mail` profile
  (Mailpit publishes on all host interfaces; use `SMTP_URL`), uses strict SSH
  host-key checking, writes a root-only `.env`/PostgreSQL backup before a
  deploy, and force-recreates only `browser-runner` when the staged seccomp bytes
  changed. Every remote Compose command is pinned to `-p agent-tasks` and the
  host compose file; overrides and `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME` in the
  host `.env` are rejected. The preflight requires `RUNNER_TOKEN` on `worker` and
  `browser-runner` with equal values and absent from `api`. The production
  compose file has no insecure secret fallbacks and labels every service
  `com.agent-tasks.stack=production`; CI checks compose parity (volume sources,
  privileged/user/network_mode/devices/sysctls/ulimits, volume
  external/driver/options and `backend.internal`), shell syntax and the offline
  deploy test, which executes the remote prereq/preflight/backup/promote bodies
  against stub docker/stat binaries.

### Changed

- Task execution has a single backend: the isolated, provisioned OpenCode 2.x
  runtime. The worker no longer has a legacy `runAgent` fallback or an
  `OPENCODE_RUNTIME_ENABLED` flag, rejects every provider kind except
  `openai-compatible`, and requires a healthy provisioner before it registers
  queues. Local/E2E Compose uses a test-only fake provisioner without a Docker
  socket, egress or provider credentials. Production keeps the real provisioner
  behind `opencode-runtime`; `deployment/deploy.sh` refuses every real deploy
  while the source-controlled `deployment/OPENCODE_RUNTIME_APPROVED` marker is
  absent, and the preflight additionally rejects that profile and an
  empty worker token until the documented verification gates pass.
- Production deployment documentation now treats
  `/opt/stacks/agent-tasks` + `deployment/deploy.sh` as the primary path.
  `deployment/stack.sh production` is local `config` validation only, and the
  Portainer migration is a historical runbook that preserves
  `SECRETS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `AUTH_SECRET`, the project name
  `agent-tasks` and the existing volumes. The manual backup/restore and rollback
  snippets fail fast before replacing `.env` or starting the stack and write
  their dumps root-only (`umask 077`, `chmod`/`install -m 0600`).

### Fixed

- The worker and the provisioner now use the persisted provider catalog instead
  of the admin-declared `config.models` snapshot: discovered models work without a
  duplicate declaration, declared metadata overrides discovery, and declared-only
  models stay usable. A provider created through the UI and refreshed through the
  normal `POST /api/admin/providers/<id>/models/refresh` route can create and run
  a task, which previously failed provisioning with "Task model is not configured
  on its provider".
- Tool support is explicit only. Discovery cannot prove it, so a model is
  tool-capable only with `config.models[] = { id, supportsTools: true }` (admin
  toggle). Tasks that need web research or memory are refused with a clear
  400/typed `unsupported` error before provisioning instead of silently running
  without their tools; the worker, runner and provisioner all repeat the check.
  Completion e-mail does not need tools (the worker sends it itself) and no longer
  blocks a tool-less model.
- Provider kinds other than `openai-compatible` are refused on task creation,
  execution-relevant updates and manual runs with an explicit message instead of
  being mapped to another adapter. The task editor lists only executable
  providers; admin and settings still show every provider, marked
  `executable: false`, and existing rows and credentials are preserved.
- A task model with a reasoning variant (`model#high`) no longer fails the
  isolated runtime with a catalog mismatch. The worker splits the suffix with the
  adapter's `parseModelVariant` semantics, validates the base id against the
  provider, and sends `{ id, variant }` through the provisioner. The provisioner
  declares all six variants on the runtime model as `reasoning_effort`, and the
  client, runner and provisioner reject a dropped, rewritten or unsupported
  variant instead of silently running the wrong effort.
- Retry, resume and duplicate validate the stored provider, model and tool
  requirements before they queue or re-enable work, so a legacy provider cannot
  produce a guaranteed-to-fail execution.
- A runtime-reported provider failure is classified again: HTTP 429 becomes
  `rate_limited`, 5xx/timeouts become `unavailable`, and both keep the existing
  bounded backoff. Unclear failures stay terminal.
- A discovered tool capability survives an admin override that only renames or
  adds metadata; only an explicit `supportsTools` value overrides it.
- Upgrading an existing local/E2E env removes the retired
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_RUNTIME_ENABLED` entries instead of
  tripping the placeholder gate.
- The test-only fake runtime's reports start with a “Simulated execution” banner
  and its startup log says TEST-ONLY, so a local run cannot be mistaken for a
  real model call.
- Tasks can notify "only when the report changes". Every completed run records
  its relation to the previous completed run (`report.change`, `first`/`changed`/
  `unchanged`/`unknown`), and the quieter mode suppresses the e-mail when the
  report text is identical while still delivering a first, changed or
  uncomparable report.
