# Docker Compose deployment, Watchtower auto-update, documentation

_Labels: deploy, docs_

## Acceptance criteria

- [x] Compose stack: api (+ SPA), worker, postgres, hardened browser runner
- [x] Optional profiles: SearXNG (search), Mailpit (mail)
- [x] Named volumes, health checks, restart policies, no published database port
- [x] Pinned images, minimal privileges, seccomp profile
- [x] Watchtower labels for api/worker only
- [x] README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, .env.example
- [x] Production services carry `com.agent-tasks.stack=production`
- [x] Deploy preflight fails closed on a missing/incompatible external `webnet`
      (exactly `172.18.0.0/16`, gateway `172.18.0.1`), an insecure host `.env`,
      an implicit `compose.override.*` file or a host `.env` that selects
      `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`, and an active search profile without
      real settings; it validates the effective Compose-interpolated values
      without printing them
- [x] `RUNNER_TOKEN` is validated on `worker` and `browser-runner` (equal values)
      and rejected on `api`; the rendered project name must be `agent-tasks`
- [x] Every remote Compose invocation is pinned to `-p agent-tasks`
      and `/opt/stacks/agent-tasks/compose.yaml` (`.next` for the candidate)
- [x] Deploy validates `docker/seccomp-browser.json` as JSON locally, stages it
      to the host and pins `RUNNER_SECCOMP_PATH` to the staged file before `up`;
      changed seccomp bytes force-recreate only `browser-runner`
- [x] Compose parity compares volume sources, targets and read-only modes; the
      documented SearXNG host bind is handled explicitly and an offline test
      covers mismatched named volumes
- [x] SSH uses BatchMode, a connect timeout and strict host-key checking against
      the operator's existing `known_hosts`
- [x] Pre-deploy root-only `.env` and PostgreSQL backup (executed offline test
      with success and stopped-database failure paths), plus a documented
      rollback that redeploys the prior commit, backs up the current state and
      restores the matching dump with `psql -v ON_ERROR_STOP=1
      --single-transaction`
- [x] Portainer migration runbook preserves `SECRETS_ENCRYPTION_KEY`,
      `POSTGRES_PASSWORD`, `AUTH_SECRET`, the project name and the volumes
- [x] CI checks compose parity, deployment shell syntax, ShellCheck and an
      offline deploy test that executes the remote prereq/preflight/backup/
      promote bodies; pre-commit glob matching runs lint/typecheck for every
      staged path, not just the joined list
- [x] Full Compose start verified locally (isolated current-tree stack; production deployment excluded)

## Evidence

`compose.yaml`, `deployment/`, `deployment/deploy.sh`,
`deployment/compose.production.yaml`, `scripts/check-compose-parity.mjs`,
`scripts/compose-parity-lib.mjs`, `scripts/test-compose-parity.mjs`,
`scripts/check-deploy-compose-contract.mjs`,
`scripts/test-deploy-dry-run.sh`, `DEPLOYMENT.md`,
`docs/VERIFICATION_REPORT.md` (isolated current-tree Compose start and E2E; production
host evidence 2026-11-02 is historical and no production deployment was performed).
