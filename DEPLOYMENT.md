# Deployment

## Ready-made stacks

[`deployment/`](deployment/README.md) has one compose entrypoint per lifecycle
stage. Local and E2E include the root `compose.yaml`. Production is a deliberately
vendored host snapshot (`deployment/compose.production.yaml`): it adds the
proxy-owned external `webnet` and the fixed API address, omits `build`, and uses
absolute host paths for support assets. CI checks the shared security invariants
with `scripts/check-compose-parity.mjs` instead of a blanket file diff.

| Stack | Command | Project name | Host ports |
| --- | --- | --- | --- |
| production | `DEPLOY_HOST=root@docker.example deployment/deploy.sh` | `agent-tasks` | API/SPA `HTTP_PORT` (default `8080`) |
| local | `deployment/stack.sh local --profile mail --profile search up -d --build` | `agent-tasks-local` | API/SPA `8090`, Mailpit `1025`/`8025` |
| E2E | `deployment/stack.sh e2e --profile mail --profile search up -d --build` | `agent-tasks-e2e` | API/SPA `8180`, Mailpit `1126`/`8126` |

The project name isolates containers, networks and volumes, and every container
carries `com.agent-tasks.stack=<stack>` (`production` on every production
service). Local and E2E therefore run at the same time. `stack.sh` fills the
development secrets on first use; `stack.sh production` is limited to local
`config` validation and cannot start a production stack. The production host
workflow is described under [Production on the Docker host](#production-on-the-docker-host-optstacks).
See [`deployment/README.md`](deployment/README.md) for the full workflow.

The remaining commands in this document use the root `compose.yaml` directly for
local development and expect the variables in the shell or `.env`. Production
commands name `/opt/stacks/agent-tasks` explicitly.

## Compose profiles

Compose starts only the services selected by a profile. `docker compose config --services`
lists exactly what a profile starts.

| Profile | Services | Purpose |
| --- | --- | --- |
| (default, root/local Compose) | postgres, api, worker, browser-runner, opencode-test-provisioner | API + SPA, scheduler and deterministic test execution; fake runtime makes no provider calls; no web search |
| `search` | searxng | SearXNG backend used by tasks with web research |
| `opencode-runtime` | `opencode-provisioner` (root/local Compose only) | Real per-execution runtime provisioner; privileged Docker socket and provider egress boundary. Do not activate in production: `deployment/deploy.sh` rejects it until verification gates pass. |

```bash
docker compose --profile search up -d --build          # first install with web search
docker compose up -d --build                           # install without web search
```

`SEARXNG_URL` defaults to `http://searxng:8080` in every profile, so web search
only works when the `search` profile is active.

## Environment variables

The API and the worker validate their environment with Zod at startup and exit on
an invalid value; the browser runner exits when `RUNNER_TOKEN` is missing or shorter
than 16 characters. "Default" is the code default, not the compose fallback.

### Application

| Variable | Read by | Default | Required |
| --- | --- | --- | --- |
| `NODE_ENV` | api, worker | `development` | no; `compose.yaml` sets `production` |
| `PORT` | api, browser-runner | `8080` (api), `8081` (runner) | no; `compose.yaml` pins both |
| `WEB_ROOT` | api | unset (Vite serves the SPA) | no in dev; the production image sets `/app/apps/web/dist` and startup fails if it has no `index.html` |
| `DATABASE_URL` | api, worker, migrations | — | yes; `compose.yaml` builds it from `POSTGRES_*` |
| `PUBLIC_BASE_URL` | api | `http://localhost:5173` | no, but set it: auth URLs, invite/reset links and trusted origins use it; compose default `http://localhost:8080` |
| `AUTH_SECRET` | api | — | yes, at least 32 characters |
| `SECRETS_ENCRYPTION_KEY` | api, worker | — | yes, base64 of exactly 32 bytes |
| `SECRETS_ENCRYPTION_KEY_PREVIOUS` | api, worker | — | no; only while rotating keys |
| `SETUP_TOKEN` | api | — | optional when `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set; otherwise required for the setup screen, at least 16 characters |
| `ADMIN_EMAIL` | api | — | no; creates the first `ADMIN` on start when no admin exists. Must be set together with `ADMIN_PASSWORD` |
| `ADMIN_PASSWORD` | api | — | no; at least 12 characters; see `ADMIN_EMAIL` |
| `ADMIN_NAME` | api | `Administrator` | no; display name of the env bootstrap admin |
| `ALLOW_REGISTRATION` | api | `false` | no; initial value of the database setting. `true` opens `/register` and direct sign-up as `USER`; the admin UI can change it later |
| `SMTP_URL` | api | — | no; when set, reset/verification/invitation mails are sent as multipart plain-text + HTML |
| `SMTP_FROM` | api | `agent-tasks@localhost` | no; only used with `SMTP_URL` |
| `SEARXNG_URL` | worker (the api schema also parses it) | —; worker falls back to the `searchBaseUrl` system setting, default `http://searxng:8080` | no; compose default `http://searxng:8080` |
| `LOG_LEVEL` | api, worker, browser-runner | `info` | no; `fatal`, `error`, `warn`, `info`, `debug` or `trace`; compose forwards it to api and worker only |
| `TRUST_PROXY` | api | `false` in code, `true` in `compose.yaml` (the stack always sits behind a reverse proxy) | no; exactly `true` or `false`; when enabled the API trusts exactly one proxy hop |
| `COOKIE_SECURE` | api | `false` | no; exactly `true` or `false` |
| `RATE_LIMIT_API_MAX` | api | `300` | no, 1–10000; global HTTP requests per minute and IP, including the SPA; forwarded by both Compose files |
| `RATE_LIMIT_SIGNIN_MAX` | api | `5` | no, 1–1000; forwarded by both Compose files |
| `RATE_LIMIT_SESSION_MAX` | api | `600` | no, 1–10000 session reads per window and IP; forwarded by both Compose files |
| `RATE_LIMIT_WINDOW_SECONDS` | api | `60` | no, 10–3600; forwarded by both Compose files |
| `RUN_MIGRATIONS` | api | unset (migrations skipped) | no; `compose.yaml` sets `"true"`, and only the exact string `true` runs them |
| `AGENT_TASKS_ENABLE_CODEX` | ai-providers (Codex) | unset (disabled) | no; `1` opts in; forwarded by `compose.yaml` (default `0`). The worker rejects the `codex` provider kind, so this only affects admin health checks and library tests |

### Worker and browser runner

| Variable | Read by | Default | Required |
| --- | --- | --- | --- |
| `RUNNER_URL` | worker | `http://browser-runner:8081` | no; `compose.yaml` pins it |
| `RUNNER_TOKEN` | worker, browser-runner | — | yes, at least 16 characters |
| `WORKER_CONCURRENCY` | worker | `1` (range 1–8) | no; sets pg-boss `localConcurrency`, i.e. parallel executions per worker process. Add replicas for more capacity |
| `WORKER_ID` | worker | `worker-<8 random hex>` | no; **not forwarded by `compose.yaml`** |
| `OPENCODE_PROVISIONER_URL` | worker | — | yes; root/local Compose targets the isolated test-only fake; production targets the real provisioner |
| `OPENCODE_PROVISIONER_TOKEN` | worker, provisioner | — | yes for a running worker; at least 32 characters. Local/E2E generates it. The production example deliberately leaves it empty while execution is disabled; without it, the worker exits environment validation, and with it but no provisioner the startup health gate prevents queue registration. |
| `RUNNER_ALLOW_HTTP` | browser-runner | `true` | no |
| `RUNNER_ALLOWED_PORTS` | browser-runner | `80,443` | no; comma-separated |
| `RUNNER_MAX_SESSIONS` | browser-runner | `2` | no |
| `RUNNER_SESSION_TTL_MS` | browser-runner | `3660000` (61 minutes) | no; must exceed the 3600-second maximum task duration |
| `RUNNER_ACTION_TIMEOUT_MS` | browser-runner | `30000` | no; **not forwarded by `compose.yaml`** |
| `RUNNER_MAX_TEXT_CHARS` | browser-runner | `30000` | no; **not forwarded by `compose.yaml`** |
| `RUNNER_CHROMIUM_SANDBOX` | browser-runner | `true` | no; `compose.yaml` pins `"true"` |
| `RUNNER_SECCOMP_PATH` | compose interpolation | `/opt/stacks/agent-tasks/docker/seccomp-browser.json` in production; `docker/seccomp-browser.json` in the root/local file | no; `deploy.sh` ships the repository profile to the production default, and an override must be an absolute host path |
| `SEARXNG_SETTINGS_PATH` | compose interpolation | `/opt/stacks/agent-tasks/docker/searxng/settings.yml` in production; `./docker/searxng/settings.yml` in the root/local file | no; the production `search` profile requires a host-only file with a generated secret (see below) |

### Compose interpolation only

These are read by `compose.yaml`, not by the application:

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_USER` | `agent` | |
| `POSTGRES_PASSWORD` | `agent` in the root/local file; **required** in production | Keep it hex: it is embedded in `DATABASE_URL` without escaping. `deployment/compose.production.yaml` has no fallback and `deploy.sh` rejects `agent`/placeholders |
| `POSTGRES_DB` | `agent_tasks` | |
| `HTTP_BIND` | `127.0.0.1` | Host interface for the API/SPA port. Keep loopback for a host reverse proxy; use `0.0.0.0` for a remote Docker daemon or a proxy container outside the compose network |
| `HTTP_PORT` | `8080` | Published host port; `PUBLIC_BASE_URL` must use the same port |
| `IMAGE_PREFIX` | `ghcr.io/all-the-rest/agent-tasks` | |
| `IMAGE_TAG` | `latest` in local/root Compose; production example uses `0` | Release selector. `deploy.sh` rejects an unset or `latest` effective tag; production must choose a published release tag such as `0`, `0.1.0` or `sha-<short>` |
| `BROWSER_MEMORY_LIMIT` | `1g` | Container limit for browser-runner |
| `BROWSER_CPUS` | `1.0` | CPU limit for browser-runner |
| `OPENCODE_MEMORY_LIMIT` | `1g` | Container memory ceiling for the profile-gated provisioned runtime |
| `OPENCODE_CPUS` | `1.0` | CPU ceiling for the profile-gated provisioned runtime |
| `OPENCODE_VERSION` | `2.2.5` | Version used when building the root Compose runtime image; production pulls the release image |
| `MAILPIT_SMTP_PORT` | `1025` | Published SMTP port of the optional `mail` profile |
| `MAILPIT_HTTP_PORT` | `8025` | Published Mailpit UI/API port |

On a remote Docker daemon (or when the proxy is a container outside this compose
project), `127.0.0.1` is the daemon's loopback, not the proxy's. Set
`HTTP_BIND=0.0.0.0` there and restrict the port at the firewall. The same applies
to the local/E2E stacks when the daemon is remote.

SearXNG's effective secret is `server.secret_key`. The repository
`docker/searxng/settings.yml` contains only the placeholder
`change-me-in-production`; do not expose it. For production, create a host-only
file with a generated key (see [Search settings](#search-settings-host-only));
`deploy.sh` never installs the placeholder and preflight rejects it while
`COMPOSE_PROFILES` contains `search`.

### Mail testing (optional `mail` profile)

`docker compose --profile mail up -d` starts Mailpit (SMTP `1025`, UI/API `8025`)
and a SpamAssassin sidecar. Point the API at it with
`SMTP_URL=smtp://mailpit:1025`; every transactional mail is then delivered to
the Mailpit inbox. `node scripts/check-mailpit.mjs` requests a password reset for
`MAIL_TO`, asserts the message is multipart with a full HTML part, and asserts
Mailpit's SpamAssassin `Score` is below `MAIL_MAX_SPAM_SCORE` (default 5). CI runs
the same script against the compose stack. The score is SpamAssassin's, surfaced
by Mailpit; it is not computed by Mailpit itself.

## Model provider (OpenAI-compatible)

Production inference uses an OpenAI-compatible endpoint: OpenCode Go, the official
OpenAI API or a self-hosted gateway. The adapter speaks
`POST {baseUrl}/chat/completions` and `GET {baseUrl}/models`.

### Register it in the UI

1. **Admin → Providers → Add provider**.
2. Kind `openai-compatible` (or `openai`; both use the same adapter and neither has a
   built-in URL).
3. Base URL: an API root or a full chat URL.
   - OpenCode Go: `https://opencode.ai/inference/go/openai/v1` (the form used by the
     adapter tests; confirm it with your account)
   - OpenAI: `https://api.openai.com/v1`
   - Gateway: your `/v1` root
   A trailing slash is removed; a value ending in `/chat/completions` is accepted and
   `/chat/completions` is stripped when models are discovered. Public hosts must use
   `https`; plain `http` is accepted only for internal single-label service names
   (`ollama`, `mock`) and private addresses. Loopback, link-local and cloud-metadata
   addresses, URL credentials and non-http(s) schemes are refused at save time.
4. User-Agent: `agent-tasks/0.1.0` by default. The UI does not edit it; change
   `config.userAgent` through the API if you need another honest identifier (generic
   SDK User-Agents are rejected by the test contract).
5. Save, then add a **credential** (the API key). It is encrypted with
   AES-256-GCM and stored in `provider_credentials`; no environment variable holds a
   provider key.
6. **Refresh models**, then optionally mark the provider as default, mark a catalog
   model as the default for new tasks, or hide a model from the task editor.

Model discovery calls `GET {baseUrl}/models`. If the endpoint has no models route,
declare models in `config.models` through the API (the UI edits only the base URL);
otherwise refresh fails with `unavailable`.

**Upgrading from the env-seeded setup.** Older releases created the Go provider from
`OPENCODE_GO_*` at startup. That seeding is gone; an existing provider row, its
encrypted credential and its catalog keep working unchanged, and nothing seeds a
duplicate. Delete the obsolete `OPENCODE_GO_*` variables from the host `.env` after
the upgrade and manage the connection in **Admin → Providers** from then on. New
installs start with no provider at all.

### Register it through the API

`POST /api/admin/providers` with this body:

```json
{
  "name": "OpenCode Go",
  "kind": "openai-compatible",
  "config": {
    "baseUrl": "https://opencode.ai/inference/go/openai/v1",
    "userAgent": "agent-tasks/0.1.0",
    "sessionHeader": "x-opencode-session",
    "headers": {},
    "timeoutMs": 120000,
    "stream": true,
    "models": []
  },
  "enabled": true,
  "isDefault": true
}
```

Store the key with `POST /api/admin/providers/<id>/credentials`:

```json
{ "apiKey": "<key>", "label": "default" }
```

Then call `POST /api/admin/providers/<id>/models/refresh` and
`POST /api/admin/providers/<id>/health`.

A user can also store a personal key with `POST /api/providers/<id>/credentials`;
it takes precedence over the administrator's shared key for that user.

Headers: the adapter sends `content-type: application/json`,
`accept: text/event-stream` while streaming (the default) or `application/json`
otherwise, the configured `user-agent`, any `config.headers`,
`authorization: Bearer <key>` when a credential exists, `openai-organization` when
`organization` is set, and one stable `x-opencode-session` value (renameable with
`sessionHeader`) per execution attempt. Streaming is on by default;
`config.stream: false` selects the JSON path.

Errors are mapped as follows; the worker retries only the transient ones, up to
three attempts:

| Response | Error code | Worker |
| --- | --- | --- |
| `401` | `auth` | execution fails |
| `402`, or `403` with an insufficient-balance body | `auth` (explicit message) | execution fails |
| other `403` | `auth` | execution fails |
| `429` | `rate_limited` (with `retry-after` when sent) | requeued with backoff |
| `5xx` | `unavailable` | requeued |
| other non-2xx | `bad_response` (status + first 300 characters) | execution fails |
| network failure | `unavailable` | requeued |
| timeout | `timeout` | requeued |

If the endpoint reports `opencode.allowance` (body) or `x-opencode-allowance`
(header), the value is recorded in the execution usage as `allowanceUsd`. The body
value wins when both are present.

Full protocol notes and the verification status:
[`docs/architecture/providers.md`](docs/architecture/providers.md).

## Published images

Every `v*` tag builds and publishes two images:

| Image | Used by |
| --- | --- |
| `ghcr.io/all-the-rest/agent-tasks/api` | `api` (serves the SPA too) and `worker` |
| `ghcr.io/all-the-rest/agent-tasks/browser-runner` | isolated Chromium runner |

Tags are the semantic version (`0.1.0`), the commit SHA (`sha-<short>`) and
`latest`. Images are `linux/amd64`; ARM hosts must build from source. `latest`
moves on every non-prerelease release, and a re-pushed version tag replaces that
artifact; use the `sha-<short>` tag when you need one fixed build.

For the Watchtower deployment, pin the major line so Watchtower
applies every compatible minor and bugfix release without crossing a breaking
major:

```env
IMAGE_PREFIX=ghcr.io/all-the-rest/agent-tasks
IMAGE_TAG=0
```

`0` moves to each compatible `0.x` release (the workflow publishes the
`{{major}}` tag); only `1.0` is a breaking change. `0.1.0` or `sha-<short>`
freezes the deployment and stops Watchtower; `latest` would also follow a future
`1.0`. Choose the tag policy once in `/opt/stacks/agent-tasks/.env`.

`deployment/deploy.sh` reconciles the host project; Compose fetches the selected
images. The api, worker and browser-runner services set `pull_policy: always`, so
a deploy uses the GHCR tag instead of rebuilding the local Dockerfiles.
The API binds to `127.0.0.1:${HTTP_PORT}` by default, so only the reverse proxy
is publicly reachable. The runner is built from a slim Node base and installs
only Playwright's headless Chromium (no Firefox/WebKit), which keeps it around
1.7 GB instead of the ~4 GB vendor Playwright image. The API image is roughly
300 MB and includes the SPA.

### Cutting a release

```bash
git tag -a v0.1.0 -m "Agent Tasks 0.1.0"
git push origin v0.1.0
```

The **Release images** workflow publishes both images and verifies an anonymous
pull. On the first release, GitHub may create the packages as private: the
workflow token cannot change org package visibility. Do one of these once:

- Organization → **Packages** → `agent-tasks/api` and
  `agent-tasks/browser-runner` → **Package settings** → **Change visibility** →
  **Public**; or
- direct settings links:
  `https://github.com/orgs/all-the-rest/packages/container/agent-tasks%2Fapi/settings`
  and
  `https://github.com/orgs/all-the-rest/packages/container/agent-tasks%2Fbrowser-runner/settings`;
  or
- add a `PACKAGES_TOKEN` repository secret with `write:packages` and org-admin
  rights; the workflow then attempts the visibility update automatically.

Until a package is public, pull it with a logged-in client:
`echo "$GH_TOKEN" | docker login ghcr.io -u <user> --password-stdin`.

## Production on the Docker host (`/opt/stacks`)

Production is the compose project `agent-tasks`, managed only on the Docker host
from `/opt/stacks/agent-tasks/`. This is the primary production path;
`deployment/stack.sh production` is only a local `config` check and cannot start,
stop or pull the host stack.

```
/opt/stacks/agent-tasks/
  compose.yaml                  # deployment/compose.production.yaml, pushed by deploy.sh
  .env                          # root:root 0600, host-only secrets and paths
  docker/seccomp-browser.json   # pushed by deploy.sh from docker/seccomp-browser.json
  docker/searxng/settings.yml   # optional search profile, created once by the operator
  backups/<UTC timestamp>/      # root-only env + postgres.sql.gz written before deploy
```

The directory is fixed by `deploy.sh` and by the host `.env` location. The compose
project name — and with it the volume prefix — comes from `name: agent-tasks` in
`deployment/compose.production.yaml`, so it stays `agent-tasks`
(`agent-tasks_postgres-data`, `agent-tasks_codex-homes`).

### Proxy network `webnet` (prerequisite)

`webnet` is owned by the Caddy/proxy stack, not by this repository. The expected
layout is subnet `172.18.0.0/16`, gateway `172.18.0.1`; the API reserves the fixed
address `172.18.0.70` as the proxy upstream and publishes no public port by
default. Create the network in the proxy stack, never with a conflicting local
Compose network:

```bash
# on the Docker host, owned by the Caddy/proxy stack
docker network inspect webnet --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}'
# expected: 172.18.0.0/16 172.18.0.1

# bootstrap only when the proxy stack has not created it yet
docker network create --driver bridge \
  --subnet 172.18.0.0/16 --gateway 172.18.0.1 webnet
```

Do not remove or recreate `webnet` once Caddy is attached; recreate the Caddy
stack or attach the proxy container to the existing network instead. The API is
reachable from Caddy as `172.18.0.70:8080` (or through the loopback port if Caddy
runs on the host).

`deploy.sh` runs a fail-closed preflight before it changes the active Compose
file. It refuses to continue unless every `webnet` IPAM entry is exactly subnet
`172.18.0.0/16` with gateway `172.18.0.1`, and at least one such entry exists;
`0.0.0.0/0`, a different subnet or a different gateway is rejected. It does not
create the network silently. The current host uses exactly that layout.

### Host bootstrap and support assets

`seccomp` is a Linux syscall filter applied by the Docker daemon **before** the
container starts, so Docker needs a profile file on the host; the env variable
only selects its path. `deploy.sh` creates
`/opt/stacks/agent-tasks/docker` safely, stages the non-secret repository profile
as `docker/seccomp-browser.json.next`, and promotes it to
`docker/seccomp-browser.json` only after preflight. Compose does not notice a
changed file behind an unchanged `seccomp=` path, so the deploy compares the
staged bytes with the host file before promotion and, when they differ (or the
file is absent), recreates **only** `browser-runner` with
`--no-deps --force-recreate`. Other services and active profiles are not
recreated by that step. The production compose default already points there, and
the deploy pins `RUNNER_SECCOMP_PATH` to that staged file for both `config` and
`up`, so no `.env` entry is needed. If an older `.env` still sets
`RUNNER_SECCOMP_PATH=/opt/agent-tasks/...`, the deploy overrides it; remove the
stale override for clarity. The deploy never writes `/opt/agent-tasks`.

The host `.env` remains exclusively host-side. Create it once, as root, from the
committed example and never overwrite a live file:

```bash
# on the Docker host
sudo install -d -m 0755 /opt/stacks/agent-tasks
if ! sudo test -e /opt/stacks/agent-tasks/.env; then
  sudo install -m 0600 -o root -g root \
    deployment/env/production.env.example /opt/stacks/agent-tasks/.env
fi
sudoedit /opt/stacks/agent-tasks/.env
```

Replace every `replace-with-*` value and the example domain/admin address.
Required: `POSTGRES_PASSWORD`,
`PUBLIC_BASE_URL` (an `https://` URL with a real host; `https://` alone,
`localhost`, `127.0.0.1` and `*.example.com` are rejected), `AUTH_SECRET` (at
least 32 characters),
`SECRETS_ENCRYPTION_KEY` (base64 of exactly 32 bytes), `RUNNER_TOKEN` (at least 16
characters, delivered to `worker` and `browser-runner`; the API must not receive
it), `COOKIE_SECURE=true` and `TRUST_PROXY=true`. For a fresh database set
either `SETUP_TOKEN` or `ADMIN_EMAIL`/`ADMIN_PASSWORD`; an existing installation
may leave both empty because the administrator already exists (remove the example
`ADMIN_EMAIL` as well). Set
`IMAGE_PREFIX=ghcr.io/all-the-rest/agent-tasks`, choose `IMAGE_TAG=0` for
Watchtower, and set `COMPOSE_PROFILES=search` only when SearXNG is configured.
The deploy preflight rejects an effective `latest` or missing release tag rather
than allowing Compose's `latest` fallback: `latest` can cross a breaking major.
The floating major tag `0` remains supported as the documented Watchtower
policy; use a full version or `sha-<short>` to freeze to a specific release.
`deploy.sh` never creates or overwrites this file. Before changing the active
stack it verifies root:root/0600, rejects an implicit `compose.override.*` file
and a host `.env` that sets `COMPOSE_FILE` or `COMPOSE_PROJECT_NAME` (the values
are not printed), renders the *effective* Compose configuration with
`docker compose -p agent-tasks --env-file .env -f compose.yaml.next
config --format json`, and validates those interpolated values. Compose therefore
decides what quoting, inline comments and `${...}` interpolation mean; the
preflight does not parse raw `KEY=` tails. The rendered JSON is piped directly
into a small parser that emits only symbolic pass/fail reasons, so `.env` values
are never printed or logged. The parser requires `RUNNER_TOKEN` on `worker` and
`browser-runner`, rejects a mismatch between them, and rejects a token that also
reaches `api`. It also requires a 32-character `OPENCODE_PROVISIONER_TOKEN` on the
worker, because the worker has no fallback execution path and exits before queue
registration without it; the production example leaves it empty on purpose, so
production deploys stay blocked until the runtime gates pass. It also requires the
rendered project name to be exactly `agent-tasks`. The host needs `python3` for that parser; a missing parser stops
the deploy instead of skipping the checks. The staged seccomp profile is parsed
as JSON locally before it is transferred, so a malformed profile fails the deploy
without host contact.

Every remote Compose command is pinned to `-p agent-tasks
--env-file /opt/stacks/agent-tasks/.env -f /opt/stacks/agent-tasks/compose.yaml`
(`compose.yaml.next` for the candidate preflight). This applies to the backup
`ps`/`exec`, the post-promote `config`, the targeted `browser-runner` recreate,
the final `up` and the status `ps`.

### Search settings (host-only)

The repository `docker/searxng/settings.yml` contains the placeholder
`server.secret_key: change-me-in-production`. `deploy.sh` does not ship it. When
the rendered configuration contains the `searxng` service (the `search` profile
is active), preflight requires the host file, rejects the placeholder, and
requires root:root mode `0600`. Create it once with a generated key and keep it
out of git:

```bash
# on the Docker host, from a checkout
sudo install -d -m 0755 /opt/stacks/agent-tasks/docker/searxng
sudo sh -c 'umask 077; sed "s|change-me-in-production|$(openssl rand -hex 32)|" \
  docker/searxng/settings.yml > /opt/stacks/agent-tasks/docker/searxng/settings.yml'
sudo chown root:root /opt/stacks/agent-tasks/docker/searxng/settings.yml
sudo chmod 0600 /opt/stacks/agent-tasks/docker/searxng/settings.yml
```

The file stays outside the repository and is readable only by the host owner; the
SearXNG container runs as root in its image, so it can read the mount. The
directory must be traversable by the container (`0755`). `SEARXNG_SETTINGS_PATH`
may override the default absolute path; remove an older
`/opt/agent-tasks/searxng-settings.yml` override or point it at this generated
file.

### Deploy, backup and rollback

The SSH connection uses `BatchMode=yes`, `ConnectTimeout=10` and
`StrictHostKeyChecking=yes` against the operator's existing
`~/.ssh/known_hosts`. If that file is missing, the deploy stops before contacting
the host; connect once with an ordinary interactive `ssh` and verify the host key
first.

The deploy stages `compose.yaml.next` and
`docker/seccomp-browser.json.next`, then runs a fail-closed preflight before the
active files change. Before any SSH connection, a real deploy also requires the
source-controlled marker `deployment/OPENCODE_RUNTIME_APPROVED`. It is absent
while the isolated OpenCode runtime's verification gates are open, so production
deploys are refused instead of leaving a restart-looping worker. The marker is
added (or removed) only in the reviewed change that closes those gates; no host
`.env` value or token can bypass it. `--dry-run` stays available without it and
prints the blocked state. The preflight checks the `.env` owner/mode, the effective
Compose-interpolated values described above, the exact
`agent-tasks_postgres-data:/var/lib/postgresql/data` mount, the exact `webnet`
subnet/gateway, rejects an active `mail` profile (Mailpit would publish on all
host interfaces; production uses `SMTP_URL`) and, only with the search profile,
the SearXNG settings. It then writes a root-only backup of `.env` and, when
Postgres is already running, a `pg_dump` to
`/opt/stacks/agent-tasks/backups/<UTC timestamp>/` before promoting the staged
files and running `docker compose up -d --wait`. When the seccomp bytes changed,
only `browser-runner` is force-recreated first; the general `up` leaves the other
services alone. A failed preflight or backup stops the deploy before any
container is recreated:

```bash
# from a checkout, with DEPLOY_HOST required
DEPLOY_HOST=root@docker.example deployment/deploy.sh --dry-run
DEPLOY_HOST=root@docker.example deployment/deploy.sh
```

While the isolated OpenCode runtime gates are open, the preflight rejects the
`opencode-runtime` profile and an empty `OPENCODE_PROVISIONER_TOKEN`. The worker
has no fallback execution path, so a deploy would otherwise replace the worker
with a restart loop. Production deploys are therefore intentionally blocked until
those gates pass and both guards are removed.

If `agent-tasks_postgres-data` exists but Postgres is stopped, the deploy stops
instead of running migrations without a dump. Start only the database
(`cd /opt/stacks/agent-tasks && docker compose -p agent-tasks --env-file .env -f compose.yaml up -d postgres`)
or take the documented `pg_dump` manually and rerun with the explicit
confirmation `DEPLOY_DB_BACKUP_CONFIRM=backed-up`. The `.env` backup is still
written in either case. Old backups are not removed automatically; prune them
according to the retention policy for the database dump.

Rolling back only the compose file or image does **not** undo migrations. To roll
back a release, redeploy the previous commit (so the vendored compose file and
application code match), pin the previous `IMAGE_TAG`, and restore the matching
database dump if a migration was not backward compatible. The restore block is
ordered: take a fresh backup of the current database and `.env` **first**, stop
the writers, then restore. It runs under `set -eu`/`set -o pipefail` and guards
the pre-rollback dump and the restore with explicit `if !` checks, so a failed
`pg_dump`, `gunzip` or SQL statement stops before `.env` is replaced or the stack
is started. Both the pre-rollback dump and the copied `.env` are root-only
(`umask 077` plus `chmod`/`install -m 0600`):

```bash
# from a checkout at the previous commit, with the host .env already backed up
git checkout <previous-commit>
DEPLOY_HOST=root@docker.example deployment/deploy.sh

# if the new migration was not backward compatible, back up the CURRENT state,
# then restore the matching dump. Strict mode stops before .env/up on any error.
set -eu
set -o pipefail
cd /opt/stacks/agent-tasks
umask 077
sudo ls -1 backups/                                  # pick <timestamp>
pre_rollback="pre-rollback-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
if ! sudo docker compose -p agent-tasks --env-file .env -f compose.yaml \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"' \
  | gzip > "$pre_rollback"; then
  echo 'pre-rollback backup failed; nothing was changed' >&2
  exit 1
fi
chmod 0600 "$pre_rollback"
sudo docker compose -p agent-tasks --env-file .env -f compose.yaml \
  stop api worker
if ! sudo gunzip -c backups/<timestamp>/postgres.sql.gz |
  sudo docker compose -p agent-tasks --env-file .env -f compose.yaml \
    exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; then
  echo 'restore failed; .env was not replaced and the stack was not restarted' >&2
  exit 1
fi
sudo install -m 0600 backups/<timestamp>/env .env    # only if .env also changed
# set IMAGE_TAG in .env to the previous release, then:
sudo docker compose -p agent-tasks --env-file .env -f compose.yaml up -d --wait
```

`git checkout <previous-commit>` is a read-only checkout; do not reset the
repository on the host. The deploy first writes a fresh backup of the current
state, so the rollback itself can be rolled back. The dump uses
`pg_dump --clean --if-exists`, so restoring it drops and recreates the dumped
objects. Restoring `.env` also restores `SECRETS_ENCRYPTION_KEY`; do not mix it
with a database dump from another key. Never delete `agent-tasks_postgres-data`
or `agent-tasks_codex-homes` to "reset" a failed rollback.

### Migration from Portainer (historical path)

Portainer is no longer the deployment path. The current host already uses project
`agent-tasks` and the volumes `agent-tasks_postgres-data` and
`agent-tasks_codex-homes`; the migration must reuse them. Migrate once, on the
host, without creating new secrets and without deleting volumes:

1. **Back up first.** While the old stack still runs, dump the database with
   `docker exec` (it does not depend on the new compose file) and copy the
   Portainer stack environment to a root-only file:

   ```bash
   sudo install -d -m 0700 /root/agent-tasks-migration
   postgres=$(sudo docker ps -q \
     --filter label=com.docker.compose.project=agent-tasks \
     --filter label=com.docker.compose.service=postgres)
   sudo docker exec "$postgres" sh -c \
     'pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"' |
     gzip | sudo tee /root/agent-tasks-migration/postgres.sql.gz >/dev/null
   # All old services, so AUTH_SECRET/SECRETS_ENCRYPTION_KEY from api/worker and
   # POSTGRES_PASSWORD from postgres are captured without printing them.
   sudo docker ps -q --filter label=com.docker.compose.project=agent-tasks |
     xargs sudo docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
     > /root/agent-tasks-migration/container.env
   sudo chmod 0600 /root/agent-tasks-migration/*
   ```

2. **Preserve the three existing secrets.** In the new
   `/opt/stacks/agent-tasks/.env`, copy `SECRETS_ENCRYPTION_KEY`,
   `POSTGRES_PASSWORD` and `AUTH_SECRET` from the Portainer stack environment (or
   from `/root/agent-tasks-migration/container.env`). Keep the values in the
   root-only files; never echo, paste or log them. Do not regenerate them:
   changing `SECRETS_ENCRYPTION_KEY` makes stored provider credentials
   unreadable, changing `POSTGRES_PASSWORD` breaks the existing database role,
   and changing `AUTH_SECRET` invalidates sessions. Keep `SECRETS_ENCRYPTION_KEY`,
   `POSTGRES_PASSWORD`, `AUTH_SECRET`, the project name `agent-tasks` and the
   volumes `agent-tasks_postgres-data` / `agent-tasks_codex-homes`.

3. **Stop the old stack without deleting data.** Use the Portainer **Stop**
   action, or the old compose file with
   `docker compose -p agent-tasks -f <old-compose-file> down` (no `-v`). Never
   use `down -v`; that removes the `agent-tasks_*` data volumes.

4. **Verify the volumes are still there and will be reused:**

   ```bash
   docker volume ls --filter name=agent-tasks_
   docker volume inspect agent-tasks_postgres-data agent-tasks_codex-homes
   ```

5. Create the host `.env` and support assets as described above, then run
   `DEPLOY_HOST=... DEPLOY_DB_BACKUP_CONFIRM=backed-up deployment/deploy.sh`
   (the explicit flag acknowledges the dump from step 1 because Postgres is
   stopped). The compose project name `agent-tasks` makes Compose reuse the
   existing volumes. Confirm the existing users and tasks are present; do not run
   the setup flow again. Keep the migration backup until the new host stack has
   served traffic successfully.

Auto-update: api and worker carry
`com.centurylinklabs.watchtower.enable=true`. browser-runner carries `false`;
postgres, searxng and the optional mail services carry no Watchtower opt-in
label. Every production service carries `com.agent-tasks.stack=production` for
filtering and monitoring. A database must not restart under a running
migration,
and the runner is pinned to a Playwright version. Run Watchtower with
`--label-enable` so only opted-in containers move. A host-wide Watchtower
**without** `--label-enable` ignores those labels and also moves browser-runner
and the databases; that is a deliberate host policy, not a project default.

```bash
docker run -d --name watchtower --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --label-enable --cleanup --interval 300
```

Re-running `deployment/deploy.sh` picks up a new image; migrations run on API
start (`RUN_MIGRATIONS=true`) and are idempotent. Watchtower can only move images
that are published under `IMAGE_PREFIX`; a locally built stack is updated by
rebuilding, not by the updater.

## HTTPS

Terminate TLS in front of the API container (Caddy, Traefik, nginx). The API
serves both `/api` and the built SPA, so the proxy needs a single upstream.
Then set:

```
PUBLIC_BASE_URL=https://tasks.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

The API only trusts `X-Forwarded-*` when `TRUST_PROXY=true`, and then exactly one
proxy hop: the direct peer must be the TLS proxy. Do not put a second proxy in
front without adjusting the hop count in code. `PUBLIC_BASE_URL` must use the
public scheme and host; otherwise cookies and invitation links point at the wrong
origin.

The proxy must **replace** `X-Forwarded-For` with the real client address; do not
append untrusted client values. Caddy does this by default. For nginx use
`proxy_set_header X-Forwarded-For $remote_addr;`, not `$proxy_add_x_forwarded_for`.
This matters for the per-IP rate limit and audit addresses. The API's global limit
also counts SPA/static requests, so all users sharing one proxy address can exhaust
a 300/minute budget; keep the proxy address rewrite correct.

## First start

Generate every secret into a local checkout's `.env` (GNU sed; on macOS use
`sed -i ''`). Do **not** run this on the production host: its
`/opt/stacks/agent-tasks/.env` is created once from
`deployment/env/production.env.example` and must never be overwritten:

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
POSTGRES_PASSWORD=$(openssl rand -hex 24)
AUTH_SECRET=$(openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
SETUP_TOKEN=$(openssl rand -hex 32)
RUNNER_TOKEN=$(openssl rand -base64 24)
OPENCODE_PROVISIONER_TOKEN=$(openssl rand -hex 32)
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=${AUTH_SECRET}|" \
  -e "s|^SECRETS_ENCRYPTION_KEY=.*|SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}|" \
  -e "s|^SETUP_TOKEN=.*|SETUP_TOKEN=${SETUP_TOKEN}|" \
  -e "s|^RUNNER_TOKEN=.*|RUNNER_TOKEN=${RUNNER_TOKEN}|" \
  -e "s|^OPENCODE_PROVISIONER_TOKEN=.*|OPENCODE_PROVISIONER_TOKEN=${OPENCODE_PROVISIONER_TOKEN}|" \
  .env
```

`SECRETS_ENCRYPTION_KEY` must decode to exactly 32 bytes, `AUTH_SECRET` needs at
least 32 characters, `SETUP_TOKEN` and `RUNNER_TOKEN` need at least 16,
`OPENCODE_PROVISIONER_TOKEN` at least 32.

Start the stack and read the setup token:

```bash
docker compose --profile search up -d --build
docker compose ps
grep '^SETUP_TOKEN=' .env
```

Deploy the stack as described above and read `SETUP_TOKEN` from
`/opt/stacks/agent-tasks/.env` on the host.

1. Open `http://localhost:8080` (or the configured `PUBLIC_BASE_URL`) → setup screen.
   Paste `SETUP_TOKEN` and create the administrator. The password needs at least 12
   characters. The endpoint answers `503` when the token is not configured and
   `409` after the first administrator exists.
2. **Admin → Providers**: register the OpenAI-compatible endpoint as described in
   [Model provider](#model-provider-openai-compatible), store the API key, refresh
   models and optionally set it as default.
3. **Admin → Users**: invite users. Invitations are single-use and expire after 7
   days. Mail needs `SMTP_URL`/`SMTP_FROM`; without SMTP the UI still shows the
   invitation link.

### Environment bootstrap (no setup screen)

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (together, password at least 12
characters). On start the API creates the first administrator when none exists
and skips the setup screen; `SETUP_TOKEN` is then optional (keep it set as a
fallback if you prefer). The bootstrap is idempotent and safe across restarts.

`ALLOW_REGISTRATION` seeds the database setting on a **fresh** database only:
`false` (default) keeps onboarding invite-only, `true` opens `/register` and
allows direct sign-up as `USER`. An administrator can change the value later in
**Admin → Settings**; the environment value never overwrites a saved setting.

### `.env.production` (local template, not the host deployment)

The committed root `.env.production` is a **local/single-host source-checkout**
template (no real secrets). It is not the production host environment and is not
read by `deployment/deploy.sh`. Do not copy it to the host as
`/opt/stacks/agent-tasks/.env`, and never start the host stack with
`docker compose --env-file .env.production`: the host uses
`/opt/stacks/agent-tasks/.env`, created from
`deployment/env/production.env.example` as described above. The template sets
`NODE_ENV=production`, `COOKIE_SECURE=true` and `ALLOW_REGISTRATION=false`. The
inference provider (OpenCode Go) is configured in the admin UI, never in this
file.

## Backup and restore

Production `deployment/deploy.sh` writes an automatic root-only backup before
each deploy under `/opt/stacks/agent-tasks/backups/<UTC timestamp>/`:

```
env                 # copy of /opt/stacks/agent-tasks/.env
postgres.sql.gz     # pg_dump --clean --if-exists output, only when Postgres was running
```

For a manual backup (local stack, or before a host migration), run on the host
from `/opt/stacks/agent-tasks` or from the checkout. On the production host the
Compose invocation is pinned to the project and file; the local stack can use the
`deployment/stack.sh local` wrapper instead:

```bash
set -eu
set -o pipefail
cd /opt/stacks/agent-tasks
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
sudo docker compose -p agent-tasks --env-file .env -f compose.yaml \
  exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"' |
  gzip > "postgres-$stamp.sql.gz"
chmod 0600 "postgres-$stamp.sql.gz"
sudo install -m 0600 .env "env-$stamp.backup"
```

Always take this backup **before** restoring an older dump; restoring replaces
the current objects. Restore with the same explicit command and fail-closed
`psql` flags; `ON_ERROR_STOP` makes psql exit non-zero on the first SQL error and
`--single-transaction` rolls the whole restore back instead of leaving a partial
state. The block runs under `set -eu`/`set -o pipefail` and guards the pipeline,
so a corrupt archive also aborts before the stack is started:

```bash
set -eu
set -o pipefail
if ! gunzip -c postgres-<timestamp>.sql.gz |
  sudo docker compose -p agent-tasks --env-file .env -f compose.yaml \
    exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; then
  echo 'restore failed; the stack was not started' >&2
  exit 1
fi
```

The guard makes the exit status explicit before starting the stack again. The
commands read the container's own `POSTGRES_USER`/`POSTGRES_DB`, so they also
work when those values were changed. Back up `SECRETS_ENCRYPTION_KEY` with the
database: without it, provider credentials in the dump are unreadable.

## Upgrade

Production upgrades go through the host workflow:

```bash
DEPLOY_HOST=root@docker.example deployment/deploy.sh
```

The script backs up `.env`/the database first, uploads the vendored compose file
and support assets, then runs `docker compose up -d --wait` in
`/opt/stacks/agent-tasks`. The services use `pull_policy: always`, so Compose
fetches the GHCR tag selected by `IMAGE_PREFIX`/`IMAGE_TAG`; the production file
has no `build`. On a local source checkout, the root `compose.yaml` pins
`pull_policy: build`, so use `docker compose up -d --build` instead of a pull.

Migrations run before the API accepts traffic; the worker waits for Postgres.
Rolling back only the compose file or `IMAGE_TAG` does **not** undo migrations.
If a migration was destructive, restore the matching database backup using the
procedure under [Deploy, backup and rollback](#deploy-backup-and-rollback).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `api` exits with `invalid environment` | `SETUP_TOKEN` non-empty and at least 16 characters; `SECRETS_ENCRYPTION_KEY` produced by `openssl rand -base64 32`; `AUTH_SECRET` at least 32 characters |
| Setup answers `503` | `SETUP_TOKEN` is missing from the API environment; set it and restart the api container |
| `setup already completed` but no admin | the `user` table has rows; restore the database backup |
| Invitation mail missing | `SMTP_URL`/`SMTP_FROM`; without SMTP the link is logged outside production and shown in Admin → Users |
| Executions stay `queued` | worker running, Postgres healthy and its `pgboss` schema reachable; delivery is serial |
| Runner answers `401` | `RUNNER_TOKEN` differs between worker and browser-runner; compose passes one variable to both |
| Browser executions fail with policy errors | `RUNNER_ALLOWED_PORTS`, `RUNNER_ALLOW_HTTP`, runner logs (`GET /v1/blocked` with the token) |
| Search returns no results | the `search` profile is not active, or `SEARXNG_URL` points at the wrong host |
| 429 on sign-in | the sign-in limit is 5 per window by default; set `RATE_LIMIT_SIGNIN_MAX` in `.env` to adjust it |
| 429 on an API or page request | the global per-IP limit is 300 requests per minute by default; set `RATE_LIMIT_API_MAX` to tune it without disabling request protection |
| Cookies not persisted | `COOKIE_SECURE` vs. plain HTTP, `PUBLIC_BASE_URL` mismatch |
| Port 8080 already in use | change `HTTP_PORT` and `PUBLIC_BASE_URL` together |
| Deploy stops with "webnet is missing" or "is not the required 172.18.0.0/16" | the proxy stack did not create `webnet`, or its IPAM entry is not exactly subnet `172.18.0.0/16` with gateway `172.18.0.1`; `0.0.0.0/0` and other subnets are rejected. Inspect it with `docker network inspect webnet`; do not delete or recreate a network that Caddy is attached to |
| Deploy stops with "known_hosts is missing or unreadable" | connect once with an ordinary interactive `ssh` and verify the host key, or install the host key in `~/.ssh/known_hosts`; strict host-key checking is enforced |
| Deploy stops with "PUBLIC_BASE_URL must include a host name" or "must be an https:// URL" | set a real `https://` URL such as `https://tasks.example.org`; `https://` alone, `http://`, `localhost` and example domains are rejected |
| Deploy stops with ".env must be root:root 0600" | fix ownership/mode on the host; never copy the file off-host or print it |
| Deploy stops with "compose.override.yaml exists" | remove the override; the deploy always pins `/opt/stacks/agent-tasks/compose.yaml` |
| Deploy stops with ".env sets COMPOSE_FILE" or "sets COMPOSE_PROJECT_NAME" | remove that line from the host `.env`; the deploy pins project `agent-tasks` and its compose file explicitly |
| Deploy stops with "not a valid JSON object" | the local `docker/seccomp-browser.json` is malformed; fix it in the repository before deploying, nothing was transferred |
| Deploy stops with "RUNNER_TOKEN must be set on worker and browser-runner only" | set `RUNNER_TOKEN` in the host `.env`; Compose passes it to `worker` and `browser-runner`, never to `api` |
| Deploy stops with a placeholder value | replace the named key in `/opt/stacks/agent-tasks/.env`; the preflight names the key and never prints the value |
| Deploy stops with "the isolated runtime is disabled in production" | expected while the OpenCode runtime gates are open: the worker cannot start without a provisioner, so the deploy refuses before changing the stack. Do not set `OPENCODE_PROVISIONER_TOKEN` or activate `opencode-runtime` until the gates in [`docs/architecture/opencode-runtime-isolation.md`](docs/architecture/opencode-runtime-isolation.md) pass and the profile rejection is removed |
| Deploy stops with "OpenCode runtime profile must remain disabled" | remove `opencode-runtime` from `COMPOSE_PROFILES`; production execution stays gated |
| Deploy stops with "could not render compose.yaml.next" | run `docker compose -p agent-tasks --env-file .env -f compose.yaml.next config -q` as root on the host; install the Compose plugin or `python3` if the message names it |
| Deploy stops with "seccomp profile" | `deploy.sh` stages `docker/seccomp-browser.json`; check that `/opt/stacks/agent-tasks/docker` is writable and neither it nor the staged profile is a symlink |
| Deploy stops with a missing SearXNG settings file or placeholder | create the root:root 0600 host file described under [Search settings](#search-settings-host-only), or remove `COMPOSE_PROFILES=search` |
| Deploy stops with "Postgres is not running" during backup | start only `postgres` (`docker compose -p agent-tasks --env-file .env -f compose.yaml up -d postgres`), or take the documented manual dump and rerun with `DEPLOY_DB_BACKUP_CONFIRM=backed-up` |
| API crash-loops after a deploy | inspect `docker compose -p agent-tasks --env-file .env -f compose.yaml logs api`; if a migration is not backward compatible, follow [Deploy, backup and rollback](#deploy-backup-and-rollback) and restore the matching dump |
