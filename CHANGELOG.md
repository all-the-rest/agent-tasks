# Changelog

## 0.1.0 — unreleased

### Added

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
- Docker Compose deployment with hardened containers and Portainer/Watchtower labels.
- Isolated production, local and E2E stacks under `deployment/` with distinct
  project names, ports, volumes and `com.agent-tasks.stack` labels, so local and
  E2E run simultaneously.
- GitHub Actions CI with lint, typecheck, tests, image builds, Trivy, gitleaks and a production-dependency audit.
