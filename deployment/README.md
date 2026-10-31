# Deployment

Three stacks share one service definition: production, a local development
stack, and the browser E2E stack. Their project names, networks, volumes, host
ports and `com.agent-tasks.stack` labels are distinct, so **local and E2E run at
the same time** on one Docker host without touching each other's data.

`../compose.yaml` stays the single source for services, health checks, security
options and profiles. The files here only add the project name and the matching
environment file:

| File | Project name | Stack label | Env file |
| --- | --- | --- | --- |
| `compose.production.yaml` | `agent-tasks` | `production` | `env/production.env` |
| `compose.local.yaml` | `agent-tasks-local` | `local` | `env/local.env` |
| `compose.e2e.yaml` | `agent-tasks-e2e` | `e2e` | `env/e2e.env` |

The project name prefixes containers, networks and volumes
(`agent-tasks-local-api-1`, `agent-tasks-local_postgres-data`). The label makes
the stack identifiable in `docker ps` and in monitoring even when only a
container ID is known. The root `compose.yaml` (used by CI and the README quick
start) uses the label `compose` unless `STACK_NAME` is set:

```bash
docker ps --filter label=com.agent-tasks.stack=local
docker ps --filter label=com.agent-tasks.stack=e2e
```

## Host ports

| Stack | Web / API | Mailpit SMTP | Mailpit UI |
| --- | --- | --- | --- |
| production | `HTTP_PORT` (default `8080`) | not started | not started |
| local | `8090` | `1025` | `8025` |
| e2e | `8180` | `1126` | `8126` |

Only `web` publishes a port; Postgres, the API, the worker, the browser runner
and SearXNG stay on the internal networks. Mailpit and SearXNG are compose
profiles and publish only when started.

## Quick start

The helper creates `env/local.env` / `env/e2e.env` from the example on first use
and fills every `__GENERATE__` marker with a random value (mode `600`). It then
runs the matching `docker compose -f deployment/compose.<stack>.yaml` command
with the arguments you pass.

```bash
# local development (web on http://localhost:8090)
deployment/stack.sh local --profile mail --profile search up -d --build

# E2E, while local keeps running (web on http://localhost:8180)
deployment/stack.sh e2e --profile mail --profile search up -d --build

# both stacks at once
docker ps --filter label=com.agent-tasks.stack

# status, logs, teardown of one stack only
deployment/stack.sh local ps
deployment/stack.sh e2e logs --no-color --tail=100 api worker
deployment/stack.sh e2e down -v
```

Without profiles only the core services start (`postgres`, `api`, `worker`,
`web`, `browser-runner`). `--profile mail` adds Mailpit and SpamAssassin;
`--profile search` adds SearXNG. `deployment/stack.sh local config --services`
lists exactly what a selection starts.

### What `stack.sh` fills

| Marker | Random value |
| --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `AUTH_SECRET` | `openssl rand -hex 32` |
| `SECRETS_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `RUNNER_TOKEN` | `openssl rand -hex 24` |
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
when the Docker daemon runs on another machine.

### Production

```bash
cp deployment/env/production.env.example deployment/env/production.env
chmod 600 deployment/env/production.env
$EDITOR deployment/env/production.env     # replace every replace-with-* value
deployment/stack.sh production --profile search up -d
```

`stack.sh` refuses to start production while a `replace-with-*` placeholder is
still present; `stack.sh production config -q` is allowed for validation.
`PUBLIC_BASE_URL`, `COOKIE_SECURE` and `TRUST_PROXY` assume a TLS-terminating
reverse proxy in front of `HTTP_PORT`. The full variable reference, backup,
update and rollback notes are in [../DEPLOYMENT.md](../DEPLOYMENT.md).

The stack always builds `../compose.yaml` from this repository, so run the
commands from a checkout that contains the desired commit. `IMAGE_TAG` and
`IMAGE_PREFIX` select pre-built images when you do not want to build locally.

## Validation

These commands need no Docker daemon:

```bash
deployment/stack.sh local config -q
deployment/stack.sh e2e config -q
deployment/stack.sh production config -q   # placeholders are allowed here
docker compose config -q                   # root file used by CI
```

To confirm the isolation contract after a start:

```bash
docker compose -f deployment/compose.local.yaml ps --format json | jq -r '.[].Labels["com.agent-tasks.stack"]'
docker network ls --filter name=agent-tasks-local
docker volume ls --filter name=agent-tasks-e2e
```

## Notes

- Never commit `env/*.env`; only the `*.env.example` files belong in git.
- The root `compose.yaml` remains the file CI uses. The deployment wrappers
  include it, so a service change applies to all three stacks at once.
- On hosts that forbid unprivileged user namespaces, set
  `RUNNER_CHROMIUM_SANDBOX=false` in the local env file. The browser then runs
  without its Chromium sandbox; keep the default `true` in production.
- `down -v` removes only the selected project's volumes. Production data is in
  `agent-tasks_postgres-data`, local data in `agent-tasks-local_postgres-data`,
  E2E data in `agent-tasks-e2e_postgres-data`.
