# Deployment

There are three stacks: production, a local development stack, and the browser E2E
stack. Local and E2E share the root `../compose.yaml` and can run at the same
time; production is a deliberately vendored host snapshot. Project names,
networks, volumes, host ports and `com.agent-tasks.stack` labels are distinct, so
**local and E2E run at the same time** on one Docker host without touching each
other's data.

`compose.production.yaml` is **not** an include of `../compose.yaml`. It adds the
Caddy/proxy-owned external `webnet` and the fixed API address `172.18.0.70`,
omits `build`, and uses absolute host paths for support assets. The shared
security-sensitive service invariants (read-only roots, capability drops, health
checks, temp filesystems, profiles, privileged/user/network_mode/devices/
sysctls/ulimits, volume sources/targets/modes and volume/network attributes,
environment and Watchtower labels) are checked by
`scripts/check-compose-parity.mjs` in CI; a blanket diff is intentionally
avoided. Named volume sources and read-only modes must match; the documented
SearXNG host bind is compared by its logical asset, and
`scripts/test-compose-parity.mjs` proves a mismatched named volume, a
service-field change, a volume attribute change and `backend.internal` drift fail
offline. Local and E2E remain true includes. `stack.sh` supplies the matching env
file with `--env-file`; the production host keeps its variables in
`/opt/stacks/agent-tasks/.env`, and `deployment/deploy.sh` never writes or prints
that file.

| File | Project name | Stack label | Env file |
| --- | --- | --- | --- |
| `compose.production.yaml` | `agent-tasks` | `production` | host `/opt/stacks/agent-tasks/.env` |
| `compose.local.yaml` | `agent-tasks-local` | `local` | `env/local.env` (stack.sh) |
| `compose.e2e.yaml` | `agent-tasks-e2e` | `e2e` | `env/e2e.env` (stack.sh) |

The project name prefixes containers, networks and volumes
(`agent-tasks-local-api-1`, `agent-tasks-local_postgres-data`). The label makes
the stack identifiable in `docker ps` and in monitoring even when only a
container ID is known; every production service carries
`com.agent-tasks.stack=production`. The root `compose.yaml` (used by CI and the
README quick start) uses the label `compose` unless `STACK_NAME` is set:

```bash
docker ps --filter label=com.agent-tasks.stack=local
docker ps --filter label=com.agent-tasks.stack=e2e
```

## Host ports

| Stack | API + SPA | Mailpit SMTP | Mailpit UI |
| --- | --- | --- | --- |
| production | `HTTP_PORT` (default `8080`) | not started | not started |
| local | `8090` | `1025` | `8025` |
| e2e | `8180` | `1126` | `8126` |

Only the API publishes a port, and it binds to loopback (`HTTP_BIND=127.0.0.1`)
by default. It serves the API and the built SPA, so a reverse proxy has one
upstream. Postgres, the worker, the browser runner and SearXNG stay on the
internal networks. Mailpit and SearXNG are compose profiles and publish only when
started.

On a remote Docker daemon the host loopback belongs to the daemon, not to the
test runner or the proxy. Set `HTTP_BIND=0.0.0.0` in the matching env file (and
restrict the port at the firewall) before pointing `E2E_BASE_URL` at it.

## Quick start

The helper creates `env/local.env` / `env/e2e.env` from the example on first use
and fills every `__GENERATE__` marker with a random value (mode `600`). It then
runs the matching `docker compose -f deployment/compose.<stack>.yaml` command
with the arguments you pass.

```bash
# local development (API + SPA on http://localhost:8090)
deployment/stack.sh local --profile mail --profile search up -d --build

# E2E, while local keeps running (API + SPA on http://localhost:8180)
deployment/stack.sh e2e --profile mail --profile search up -d --build

# both stacks at once
docker ps --filter label=com.agent-tasks.stack

# status, logs, teardown of one stack only
deployment/stack.sh local ps
deployment/stack.sh e2e logs --no-color --tail=100 api worker
deployment/stack.sh e2e down -v
```

Without profiles, local/E2E starts (`postgres`, `api`, `worker`,
`browser-runner`, `opencode-test-provisioner`). The fake provisioner is internal,
has no Docker socket or egress, ignores provider credentials, and supplies
deterministic execution coverage without an external model. **A task run on this
stack is simulated:** its report starts with a “Simulated execution” banner, and
no provider is called. The local stack is therefore a development/demo
environment, not a way to run real research. The real
`opencode-provisioner` is behind `opencode-runtime`; it is not used by local/E2E
by default and must not be activated in production before its verification gates
pass. `deployment/deploy.sh` refuses every real production deploy while the
source-controlled `OPENCODE_RUNTIME_APPROVED` marker is absent and rejects that
production profile. `--profile mail` adds Mailpit and SpamAssassin;
`--profile search` adds SearXNG. `deployment/stack.sh local config --services`
lists exactly what a selection starts.

### What `stack.sh` fills

| Marker | Random value |
| --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `AUTH_SECRET` | `openssl rand -hex 32` |
| `SECRETS_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `RUNNER_TOKEN` | `openssl rand -hex 24` |
| `OPENCODE_PROVISIONER_TOKEN` | `openssl rand -hex 32` (internal local/E2E fake service authentication) |
| `SETUP_TOKEN` and `E2E_SETUP_TOKEN` | the same `setup-<hex>` value |
| `ADMIN_PASSWORD` and `E2E_ADMIN_PASSWORD` | the same `Admin-<hex>` value |

The generated files are ignored by git. Delete one and run the helper again to
rotate that stack's development secrets (the database volume keeps the old data,
so also remove the volume with `down -v` for a clean slate).

### Running the E2E suite

The stack and Playwright must agree on the base URL and the bootstrap values.
Source the generated env file so the test runner sees the exported values:

```bash
deployment/stack.sh e2e --profile mail --profile search up -d --build
( set -a; . deployment/env/e2e.env; set +a; pnpm exec playwright install chromium; pnpm test:e2e )
```

`E2E_BASE_URL` points at `http://localhost:8180`. The suite starts its
deterministic OpenAI-compatible mock on the host; Docker reaches it through the
first non-loopback IPv4 address. Set `E2E_MOCK_BASE_URL=http://<gateway>:18099`
when the Docker daemon runs on another machine. Task execution itself goes through
the network-internal fake provisioner, so the suite needs no model download or
provider egress. `FAKE_RUNTIME_MEMORY_OPS=1` (set in `env/e2e.env.example` and by
`stack.sh`) makes the fake emit one finding and one recommendation per session for
the learning checks; the mock above still backs provider discovery and health.

### Production (host-managed)

Production is the compose project `agent-tasks` in `/opt/stacks/agent-tasks` and
is the primary production path. The host `.env`, seccomp profile and optional
SearXNG settings are host-side; see
[../DEPLOYMENT.md#production-on-the-docker-host-optstacks](../DEPLOYMENT.md#production-on-the-docker-host-optstacks)
for the layout, `webnet` prerequisite and the Portainer migration procedure.

```bash
# from a checkout; DEPLOY_HOST is required
DEPLOY_HOST=root@docker.example deployment/deploy.sh --dry-run
DEPLOY_HOST=root@docker.example deployment/deploy.sh
```

The preflight fails closed when `/opt/stacks/agent-tasks/.env` is not
root:root/0600, an implicit `compose.override.*` file exists, the host `.env`
sets `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`, the effective Compose-interpolated
values are empty/placeholders or use a hostless/non-HTTPS `PUBLIC_BASE_URL`,
`RUNNER_TOKEN` is missing from `worker` or `browser-runner`, differs between
them, or reaches `api`, the worker has no `OPENCODE_PROVISIONER_TOKEN` (the worker
exits without the runtime, so the deploy refuses instead of leaving a restart
loop), an `opencode-runtime` profile is active, `webnet` is missing or is not exactly subnet
`172.18.0.0/16` with gateway `172.18.0.1`, or the search profile lacks a
root:root 0600 SearXNG settings file with a generated secret. Values are
rendered with `docker compose config` and piped through a symbolic parser; they
are never printed. Every remote Compose call is pinned to
`-p agent-tasks --env-file /opt/stacks/agent-tasks/.env -f
/opt/stacks/agent-tasks/compose.yaml` (the staged `.next` file for the candidate
check). It never creates `webnet`. `deploy.sh` validates the seccomp profile as
JSON locally, then writes an automatic `.env`/`pg_dump` backup under
`/opt/stacks/agent-tasks/backups/`, stages and promotes
`docker/seccomp-browser.json`, pins `RUNNER_SECCOMP_PATH` to that staged file,
and only then reconciles the stack. If the staged seccomp bytes changed, only
`browser-runner` is force-recreated. SSH uses strict host-key checking against
the operator's existing `~/.ssh/known_hosts`. The rollback and Portainer
migration procedures are in [../DEPLOYMENT.md](../DEPLOYMENT.md).

`deployment/stack.sh production config -q` is **local config validation only**.
It renders `compose.production.yaml` with the committed
`env/production.env.example`; it never creates `deployment/env/production.env`,
starts, stops or pulls the host stack. Do not use a local `production.env` on the
host. There is no Portainer stack anymore: the host runs the compose project
directly, and Watchtower updates the images.

The API image contains the built SPA; there is no separate web container. The
release workflow publishes
`ghcr.io/all-the-rest/agent-tasks/{api,browser-runner,opencode,opencode-provisioner}`
for every `v*` tag. The test-only fake provisioner is built from this checkout
and is never published as a production runtime. `IMAGE_TAG` selects the release;
the production compose file has no `build` section and pulls the registry tag. A
local source checkout can still use `deployment/stack.sh local ... --build`.

## Validation

These commands need no Docker daemon:

```bash
deployment/stack.sh local config -q
deployment/stack.sh e2e config -q
deployment/stack.sh production config -q   # local validation only; placeholders allowed
OPENCODE_PROVISIONER_TOKEN=local-validation-token-0123456789abcdef \
  docker compose --env-file deployment/env/production.env.example config -q
                                            # root file used by the local quick start;
                                            # the fake provisioner requires a token
bash -n deployment/deploy.sh
sh -n deployment/stack.sh
shellcheck -S warning deployment/deploy.sh deployment/stack.sh \
  scripts/test-deploy-dry-run.sh            # warning-level shell lint
sh scripts/test-deploy-dry-run.sh           # offline: executes prereq/preflight/backup/promote bodies
node scripts/test-compose-parity.mjs        # offline: mismatched named volumes fail
node scripts/check-deploy-compose-contract.mjs
                                            # offline: RUNNER_TOKEN service ownership
node scripts/check-compose-parity.mjs       # shared security invariants (Docker CLI)
```

To confirm the isolation contract after a start:

```bash
docker compose -f deployment/compose.local.yaml ps --format json | jq -r '.[].Labels["com.agent-tasks.stack"]'
docker network ls --filter name=agent-tasks-local
docker volume ls --filter name=agent-tasks-e2e
```

## Notes

- Never commit `env/*.env` or a host SearXNG settings file; only the
  `*.env.example` files belong in git.
- The root `compose.yaml` remains the file CI uses for local/E2E. Local and E2E
  include it; production is the vendored file guarded by
  `scripts/check-compose-parity.mjs`, so a security-relevant service change must
  be made in both places.
- On hosts that forbid unprivileged user namespaces, set
  `RUNNER_CHROMIUM_SANDBOX=false` in the local env file. The browser then runs
  without its Chromium sandbox; keep the default `true` in production.
- `down -v` removes only the selected project's volumes. Production data is in
  `agent-tasks_postgres-data`, local data in `agent-tasks-local_postgres-data`,
  E2E data in `agent-tasks-e2e_postgres-data`. Never run `down -v` for production;
  it deletes the database and Codex home volumes.
