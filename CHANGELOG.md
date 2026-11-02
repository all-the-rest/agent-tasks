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

- Production deployment documentation now treats
  `/opt/stacks/agent-tasks` + `deployment/deploy.sh` as the primary path.
  `deployment/stack.sh production` is local `config` validation only, and the
  Portainer migration is a historical runbook that preserves
  `SECRETS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `AUTH_SECRET`, the project name
  `agent-tasks` and the existing volumes. The manual backup/restore and rollback
  snippets fail fast before replacing `.env` or starting the stack and write
  their dumps root-only (`umask 077`, `chmod`/`install -m 0600`).
