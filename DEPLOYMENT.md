# Deployment

## Ready-made stacks

[`deployment/`](deployment/README.md) has one compose entrypoint per lifecycle
stage. They include the root `compose.yaml`, so services and security settings
have a single source.

| Stack | Command | Project name | Host ports |
| --- | --- | --- | --- |
| production | `deployment/stack.sh production pull && deployment/stack.sh production up -d` | `agent-tasks` | API/SPA `HTTP_PORT` (default `8080`) |
| local | `deployment/stack.sh local --profile mail --profile search up -d --build` | `agent-tasks-local` | API/SPA `8090`, Mailpit `1025`/`8025` |
| E2E | `deployment/stack.sh e2e --profile mail --profile search up -d --build` | `agent-tasks-e2e` | API/SPA `8180`, Mailpit `1126`/`8126` |

The project name isolates containers, networks and volumes, and every container
carries `com.agent-tasks.stack=<stack>`. Local and E2E therefore run at the same
time. `stack.sh` fills the development secrets on first use and refuses to start
production while a `replace-with-*` placeholder remains. See
[`deployment/README.md`](deployment/README.md) for the full workflow.

The commands in this document use the root `compose.yaml` directly (CI does the
same) and expect the variables in the shell or `.env`.

## Compose profiles

Compose starts only the services selected by a profile. `docker compose config --services`
lists exactly what a profile starts.

| Profile | Services | Purpose |
| --- | --- | --- |
| (default) | postgres, api, worker, browser-runner | API + SPA, scheduler and execution; no web search |
| `search` | searxng | SearXNG backend used by tasks with web research |

```bash
docker compose --profile search up -d --build          # first install with web search
docker compose up -d                                   # install without web search
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
| `OPENCODE_GO_API_KEY` | api | — | no; when set (with a model) the API creates an `OpenCode Go` provider and stores the key encrypted on first start |
| `OPENCODE_GO_BASE_URL` | api | `https://opencode.ai/inference/go/openai/v1` | no |
| `OPENCODE_GO_MODEL` | api | — | required when `OPENCODE_GO_API_KEY` is set unless `OPENCODE_GO_MODELS` is given; may carry a variant suffix (`model-id#high`) |
| `OPENCODE_GO_MODELS` | api | — | no; comma-separated list, overrides `OPENCODE_GO_MODEL` |
| `OPENCODE_GO_NAME` | api | `OpenCode Go` | no; provider name used for idempotency |
| `SMTP_URL` | api | — | no; when set, reset/verification/invitation mails are sent as multipart plain-text + HTML |
| `SMTP_FROM` | api | `agent-tasks@localhost` | no; only used with `SMTP_URL` |
| `SEARXNG_URL` | worker (the api schema also parses it) | —; worker falls back to the `searchBaseUrl` system setting, default `http://searxng:8080` | no; compose default `http://searxng:8080` |
| `LOG_LEVEL` | api, worker, browser-runner | `info` | no; `fatal`, `error`, `warn`, `info`, `debug` or `trace`; compose forwards it to api and worker only |
| `TRUST_PROXY` | api | `false` in code, `true` in `compose.yaml` (the stack always sits behind a reverse proxy) | no; exactly `true` or `false`; when enabled the API trusts exactly one proxy hop |
| `COOKIE_SECURE` | api | `false` | no; exactly `true` or `false` |
| `RATE_LIMIT_SIGNIN_MAX` | api | `5` | no, 1–1000; forwarded by `compose.yaml` |
| `RATE_LIMIT_WINDOW_SECONDS` | api | `60` | no, 10–3600; forwarded by `compose.yaml` |
| `RUN_MIGRATIONS` | api | unset (migrations skipped) | no; `compose.yaml` sets `"true"`, and only the exact string `true` runs them |
| `AGENT_TASKS_ENABLE_CODEX` | ai-providers (Codex) | unset (disabled) | no; `1` opts in; forwarded by `compose.yaml` (default `0`). The worker additionally requires `CODEX_ISOLATED_RUNNER=1` before it will run Codex |

### Worker and browser runner

| Variable | Read by | Default | Required |
| --- | --- | --- | --- |
| `RUNNER_URL` | worker | `http://browser-runner:8081` | no; `compose.yaml` pins it |
| `RUNNER_TOKEN` | worker, browser-runner | — | yes, at least 16 characters |
| `WORKER_CONCURRENCY` | worker | `1` (range 1–8) | no; sets pg-boss `localConcurrency`, i.e. parallel executions per worker process. Add replicas for more capacity |
| `WORKER_ID` | worker | `worker-<8 random hex>` | no; **not forwarded by `compose.yaml`** |
| `CODEX_HOME_ROOT` | worker | `/var/lib/agent-tasks/codex` | no, must be absolute; the per-user directory is a hash of the owner id below this root. `compose.yaml` forwards it and mounts the `codex-homes` volume there |
| `RUNNER_ALLOW_HTTP` | browser-runner | `true` | no |
| `RUNNER_ALLOWED_PORTS` | browser-runner | `80,443` | no; comma-separated |
| `RUNNER_MAX_SESSIONS` | browser-runner | `2` | no |
| `RUNNER_SESSION_TTL_MS` | browser-runner | `900000` in `compose.yaml` | no; must exceed the longest task duration |
| `RUNNER_ACTION_TIMEOUT_MS` | browser-runner | `30000` | no; **not forwarded by `compose.yaml`** |
| `RUNNER_MAX_TEXT_CHARS` | browser-runner | `30000` | no; **not forwarded by `compose.yaml`** |
| `RUNNER_CHROMIUM_SANDBOX` | browser-runner | `true` | no; `compose.yaml` pins `"true"` |
| `RUNNER_SECCOMP_PATH` | compose interpolation | `docker/seccomp-browser.json` | no; absolute host path when the compose file is pasted into Portainer without the repository |
| `SEARXNG_SETTINGS_PATH` | compose interpolation | `./docker/searxng/settings.yml` | no; absolute host path for the optional `search` profile in a manual Portainer stack |

### Compose interpolation only

These are read by `compose.yaml`, not by the application:

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_USER` | `agent` | |
| `POSTGRES_PASSWORD` | `agent` | Set a real value. Keep it hex: it is embedded in `DATABASE_URL` without escaping |
| `POSTGRES_DB` | `agent_tasks` | |
| `HTTP_BIND` | `127.0.0.1` | Host interface for the API/SPA port. Keep loopback for a host reverse proxy; use `0.0.0.0` for a remote Docker daemon or a proxy container outside the compose network |
| `HTTP_PORT` | `8080` | Published host port; `PUBLIC_BASE_URL` must use the same port |
| `IMAGE_PREFIX` | `ghcr.io/all-the-rest/agent-tasks` | |
| `IMAGE_TAG` | `latest` | Release selector |
| `BROWSER_MEMORY_LIMIT` | `1g` | Container limit for browser-runner |
| `BROWSER_CPUS` | `1.0` | CPU limit for browser-runner |
| `MAILPIT_SMTP_PORT` | `1025` | Published SMTP port of the optional `mail` profile |
| `MAILPIT_HTTP_PORT` | `8025` | Published Mailpit UI/API port |

On a remote Docker daemon (or when the proxy is a container outside this compose
project), `127.0.0.1` is the daemon's loopback, not the proxy's. Set
`HTTP_BIND=0.0.0.0` there and restrict the port at the firewall. The same applies
to the local/E2E stacks when the daemon is remote.

SearXNG's effective secret is `server.secret_key` in
`docker/searxng/settings.yml`; change it before exposing the `search` profile.

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
   `/chat/completions` is stripped when models are discovered.
4. User-Agent: `agent-tasks/0.1.0` by default. The UI does not edit it; change
   `config.userAgent` through the API if you need another honest identifier (generic
   SDK User-Agents are rejected by the test contract).
5. Save, then add a **credential** (the API key). It is encrypted with
   AES-256-GCM and stored in `provider_credentials`; no environment variable holds a
   provider key.
6. **Refresh models**, then optionally mark the provider as default.

Model discovery calls `GET {baseUrl}/models`. If the endpoint has no models route,
declare models in `config.models` through the API (the UI edits only the base URL);
otherwise refresh fails with `unavailable`.

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

For the Portainer + Watchtower deployment, pin the major line so Watchtower
applies every compatible minor and bugfix release without crossing a breaking
major:

```env
IMAGE_PREFIX=ghcr.io/all-the-rest/agent-tasks
IMAGE_TAG=0
```

`0` moves to each compatible `0.x` release (the workflow publishes the
`{{major}}` tag); only `1.0` is a breaking change. `0.1.0` or `sha-<short>`
freezes the deployment and stops Watchtower; `latest` would also follow a future
`1.0`. Choose the tag policy once in the Portainer stack environment.

`deployment/stack.sh production pull` fetches the images; `up -d` starts them.
The production overlay sets `pull_policy: always` for api, worker and
browser-runner, so a Portainer deploy uses the GHCR tag instead of rebuilding the
local Dockerfiles. The API binds to `127.0.0.1:${HTTP_PORT}` by default, so only
the reverse proxy is publicly reachable. The runner is built from a slim Node base and installs
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

## Portainer (current setup)

The current production stack is created manually: the compose file and
environment are pasted into Portainer, not read from the repository.

1. Stack → **Add stack** → **Web editor**. Paste the root [`compose.yaml`](compose.yaml)
   (the single-file service definition; do not paste the `deployment/` overlay
   because it includes `../compose.yaml`).
2. Add the keys from `deployment/env/production.env.example` to the stack
   environment. At minimum set `POSTGRES_PASSWORD`, `AUTH_SECRET`,
   `SECRETS_ENCRYPTION_KEY`, `SETUP_TOKEN`, `RUNNER_TOKEN`, `PUBLIC_BASE_URL`
   and `IMAGE_PREFIX=ghcr.io/all-the-rest/agent-tasks`; set `IMAGE_TAG=0` for
   Watchtower. `COMPOSE_PROFILES=search` enables SearXNG.
3. Put `docker/seccomp-browser.json` on the Docker host and set
   `RUNNER_SECCOMP_PATH` to that absolute path (for example
   `/opt/agent-tasks/seccomp-browser.json`). For the `search` profile, put
   `docker/searxng/settings.yml` on the host and set `SEARXNG_SETTINGS_PATH` to
   its absolute path.
4. Deploy without Portainer's build option. The services set
   `pull_policy: always`, so Compose pulls the public GHCR tag selected by
   `IMAGE_PREFIX`/`IMAGE_TAG` instead of building the local Dockerfiles.
5. Select profiles with `COMPOSE_PROFILES` in the stack environment; the stack
   editor has no profile switch.

A Git-backed Portainer stack is also supported: use
`deployment/compose.production.yaml` as the compose path and put the same
variables in the stack environment. That overlay includes the root file and
deliberately has no `env_file`, so it starts from a clean checkout without a
committed secret file.

Auto-update: api and worker carry
`com.centurylinklabs.watchtower.enable=true`. browser-runner carries `false`;
postgres and searxng carry no label. A database must not restart under a running
migration,
and the runner is pinned to a Playwright version. Run Watchtower with
`--label-enable` so only opted-in containers move.

```bash
docker run -d --name watchtower --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --label-enable --cleanup --interval 300
```

Portainer's own re-pull/redeploy works as well; migrations run on API start
(`RUN_MIGRATIONS=true`) and are idempotent. Watchtower can only move images that are
published under `IMAGE_PREFIX`; a locally built stack is updated by rebuilding, not
by the updater.

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

Generate every secret into `.env` (GNU sed; on macOS use `sed -i ''`):

```bash
cp .env.example .env
POSTGRES_PASSWORD=$(openssl rand -hex 24)
AUTH_SECRET=$(openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
SETUP_TOKEN=$(openssl rand -hex 32)
RUNNER_TOKEN=$(openssl rand -base64 24)
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=${AUTH_SECRET}|" \
  -e "s|^SECRETS_ENCRYPTION_KEY=.*|SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}|" \
  -e "s|^SETUP_TOKEN=.*|SETUP_TOKEN=${SETUP_TOKEN}|" \
  -e "s|^RUNNER_TOKEN=.*|RUNNER_TOKEN=${RUNNER_TOKEN}|" \
  .env
```

`SECRETS_ENCRYPTION_KEY` must decode to exactly 32 bytes, `AUTH_SECRET` needs at
least 32 characters, `SETUP_TOKEN` and `RUNNER_TOKEN` need at least 16.

Start the stack and read the setup token:

```bash
docker compose --profile search up -d --build
docker compose ps
grep '^SETUP_TOKEN=' .env
```

In Portainer, deploy the stack as described above and read `SETUP_TOKEN` from the
stack's environment.

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

### `.env.production`

The repository ships a production template at `.env.production` (no real
secrets). Replace every `replace-…` placeholder, then start with:

```bash
docker compose --env-file .env.production --profile search up -d --build
```

It sets `NODE_ENV=production`, `COOKIE_SECURE=true`, `ALLOW_REGISTRATION=false`
and configures an OpenCode Go provider through `OPENCODE_GO_*`. On first start
the provider is created (only if a provider with that name does not exist) and
its API key is encrypted with `SECRETS_ENCRYPTION_KEY`. `OPENCODE_GO_MODEL` (or
`OPENCODE_GO_MODELS`) is required when a key is set.

## Backup and restore

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > backup.sql.gz
gunzip -c backup.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The commands read the container's own `POSTGRES_USER`/`POSTGRES_DB`, so they also
work when those values were changed. Back up `SECRETS_ENCRYPTION_KEY` with the
database: without it, provider credentials in the dump are unreadable.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

If the images are published under `IMAGE_PREFIX`, `docker compose pull` fetches
them; otherwise rebuild with `docker compose up -d --build`. Migrations run before
the API accepts traffic; the worker waits for Postgres. Roll back by pinning the
previous `IMAGE_TAG` — a downgrade may require restoring the database backup if a
migration was not additive.

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
| 429 on sign-in | the sign-in limit is 5 per window by default; `RATE_LIMIT_SIGNIN_MAX` only applies after it is added to the api environment |
| Cookies not persisted | `COOKIE_SECURE` vs. plain HTTP, `PUBLIC_BASE_URL` mismatch |
| Port 8080 already in use | change `HTTP_PORT` and `PUBLIC_BASE_URL` together |
