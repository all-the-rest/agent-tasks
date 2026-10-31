# Agent Tasks

Self-hosted AI task scheduler: recurring research tasks, a real agent loop,
OpenAI-compatible inference (OpenCode Go, OpenAI, self-hosted gateways), an
isolated Chromium runner, and strict multi-user isolation.

> **Status:** early but working. Every claim in this README is backed by a test or a
> command you can rerun — see [`docs/VERIFICATION_REPORT.md`](docs/VERIFICATION_REPORT.md)
> for the current evidence and the open gates. The OpenAI-compatible adapter is
> tested against deterministic local mocks; no OpenCode Go account was available in
> the verification environment, so real-account behaviour is **NOT VERIFIED**
> ([details](docs/architecture/providers.md#verification-status)).

## What it does

- **Scheduled tasks per user.** Cron or presets (once, daily, selected weekdays,
  weekly, monthly, custom), IANA timezones, correct handling of DST gaps and
  overlaps (Europe/Vienna tested).
- **A real agent.** The model chooses from a fixed set of validated tools (ten
  defined; nine exposed, form filling off), observes results and iterates. No shell,
  no arbitrary JavaScript, no unrestricted file system.
- **Web research.** SearXNG-backed search, Playwright page visits, extracted text,
  collected sources, honest "unknown" reporting.
- **Bring your own endpoint.** OpenAI-compatible providers are the production path:
  OpenCode Go, the official OpenAI API or any gateway that speaks
  `/chat/completions`. Provider keys are AES-256-GCM encrypted at rest and are never
  read from environment variables. A legacy Ollama adapter remains for local
  development only; it is not part of the compose deployment.
- **Multi-user by construction.** Every read and write is scoped to the owner,
  including background execution. Admin rights never imply access to a user's
  task, report or credential.
- **Hardened browser.** Chromium runs in its own container, non-root, read-only
  root filesystem, no capabilities, no Docker socket, behind an enforcing egress
  proxy that resolves DNS itself (DNS rebinding) and re-checks every redirect hop.

## Architecture in one picture

```
 Browser ──► web (nginx, static) ──/api──► api (Fastify)
                                             │  Better Auth sessions, RBAC, audit
                                             ▼
                                        PostgreSQL ◄── worker (pg-boss)
                                             ▲              │ agent loop
                                             │              ▼
                                        executions     browser-runner ──► enforcing proxy ──► Internet
                                                                            │
                                                                       blocked: loopback,
                                                                       RFC1918, link-local,
                                                                       metadata, ULA, …
```

Details: [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Quick start (Docker Compose)

```bash
git clone https://github.com/all-the-rest/agent-tasks.git
cd agent-tasks
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
docker compose --profile search up -d --build
grep '^SETUP_TOKEN=' .env
```

`sed -i` is GNU syntax; on macOS use `sed -i ''`. Compose fallbacks are
`POSTGRES_PASSWORD=agent`, `PUBLIC_BASE_URL=http://localhost:8080` and
`HTTP_PORT=8080`; the generated `.env` above overrides the secrets. Every variable
and its code default is listed in [`DEPLOYMENT.md`](DEPLOYMENT.md).

Open `http://localhost:8080`, paste the token from the last command on the setup
screen and create the first administrator.

Alternatively set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters) and
optionally `ADMIN_NAME` in `.env`: the API creates the first administrator on
start and the setup screen is skipped. Both variables must be set together.

For production, `.env.production` is a ready template: replace the placeholders
(domain, PostgreSQL and auth secrets, admin credentials, OpenCode Go key/model)
and start with `docker compose --env-file .env.production up -d`. It sets
`ALLOW_REGISTRATION=false` and seeds an **OpenCode Go** provider from
`OPENCODE_GO_*` on first start; the API key is encrypted at rest. The
registration value is only the initial database setting — an administrator can
change it later in **Admin → Settings**.

Then:

1. **Admin → Providers** → kind `openai-compatible`, base URL
   `https://opencode.ai/inference/go/openai/v1` for OpenCode Go (confirm it with your
   account) or your endpoint's API root, save, store the API key as a credential,
   refresh models.
2. **Admin → Users** → invite users (single-use link, valid 7 days).

`--profile search` starts SearXNG; omit it for an install without web search. Its
secret is `server.secret_key` in `docker/searxng/settings.yml`; change it before
exposing the profile. Provider details, headers and error mapping:
[`docs/architecture/providers.md`](docs/architecture/providers.md).

## Development

```bash
pnpm install
cp .env.example .env            # uncomment DATABASE_URL, fill the required secrets
set -a; . ./.env; set +a        # the apps do not read .env themselves
pnpm db:generate && pnpm db:migrate
pnpm dev                        # api :8080, web :5173 (proxy -> api), worker
```

The worker expects a browser runner at `RUNNER_URL` (default
`http://browser-runner:8081`). For local browser tasks, start
`pnpm --filter @agent-tasks/browser-runner dev` on port 8081 and set
`RUNNER_URL=http://127.0.0.1:8081`. Chromium runs with its internal sandbox:
the shipped seccomp profile allows `unshare(CLONE_NEWUSER)` and
`clone(CLONE_NEWUSER|…)`, and the container keeps `CAP_SYS_CHROOT` for the
sandbox's chroot. The host kernel must permit unprivileged user namespaces;
if it does not, the runner refuses to start unless you explicitly set
`RUNNER_CHROMIUM_SANDBOX=false` (logged as `sandbox_disabled`, never for
production). The `PUBLIC_BASE_URL` in `.env.example` targets the compose port;
for the Vite dev server change it to `http://localhost:5173` so reset links
point at the dev UI.

Quality gates:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration           # needs Postgres, see TESTING.md
pnpm build
```

## Providers

| Kind | Notes |
| --- | --- |
| `openai-compatible` | **Primary.** Any endpoint with `/chat/completions`; `/models` is used for discovery, or declare models in `config.models`. Sends an honest `User-Agent`, one stable `x-opencode-session` per execution attempt, streams by default and honours any extra headers you configure. |
| `openai` | Same adapter, no built-in defaults: set `baseUrl` to `https://api.openai.com/v1`. |
| `ollama` | Legacy/development adapter, not deployed in production. Models come from `/api/tags`, tool support from `/api/show`; a model without the `tools` capability is refused. |
| `codex` | Experimental, **disabled by default**. Account-scoped `codex exec` with a per-user `CODEX_HOME` under `CODEX_HOME_ROOT`, no tool calling, no browser cookies. See [`docs/architecture/providers.md`](docs/architecture/providers.md). |

## Security posture

- Public registration is off by default (`ALLOW_REGISTRATION=false` and the
  admin settings toggle); onboarding is invite-only with single-use tokens.
  Enabling it opens the `/register` page and a direct sign-up as `USER`; an
  administrator can switch it off at any time.
- Sessions are revocable; sign-out invalidates the session on the next request.
- TOTP MFA (with backup codes) is available and tested end to end.
- Passwords are hashed by Better Auth; there are no default credentials.
- Provider secrets are AES-256-GCM encrypted at rest and never returned by an API.
- CSRF: Better Auth origin checks plus an explicit origin guard on the app routes.
- SSRF: URL policy in the tool layer **and** an enforcing proxy in the browser
  container, which resolves DNS and pins the checked address.
- Reports render Markdown through `rehype-sanitize`; stored XSS is covered by tests.

Full threat model: [`SECURITY.md`](SECURITY.md).

## Repository layout

```
apps/web              React 19 + Vite + Tailwind 4 + daisyUI
apps/api              Fastify 5 REST API, Better Auth, RBAC, audit log
apps/worker           pg-boss scheduler + agent execution, leases, retries
services/browser-runner  Playwright + enforcing egress proxy
packages/shared       Zod schemas, schedule math, network policy, errors
packages/database     Drizzle schema, SQL migrations
packages/ai-providers OpenAI-compatible, Codex and legacy Ollama adapters, secret box
packages/agent-runtime  Tool definitions, prompt policy, agent loop
packages/browser-tools  Runner client, SearXNG client
packages/mock-openai  Deterministic OpenAI-compatible test endpoint
```

## License

Apache-2.0. See [`LICENSE`](LICENSE).
