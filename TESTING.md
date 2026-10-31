# Testing

## Layers

| Suite | Command | Needs |
| --- | --- | --- |
| Unit | `pnpm test:unit` | nothing |
| Integration | `pnpm test:integration` | PostgreSQL 17 (`TEST_DATABASE_URL`) |
| Browser E2E | `pnpm test:e2e` | running stack (`compose up`) |
| Security | part of unit + integration | — |

Unit tests cover schedule math (including both DST transitions in Europe/Vienna),
address classification, URL policy, provider adapters against a real mock HTTP
server, the agent loop (tool allowlist, limits, untrusted content, cancellation) and
the egress proxy (loopback, private, IPv6, rebinding, port policy).

Integration tests use a real PostgreSQL and the real Fastify app via `inject`:
authentication, invitations, MFA, rate limits, CSRF, multi-user isolation (IDOR),
scheduler transactions, duplicate prevention, lease claiming, crash recovery, and a
full execution against a real Chromium plus a real public page.

## Integration database

```bash
docker run -d --name agent-tasks-test-db -e POSTGRES_PASSWORD=agent \
  -e POSTGRES_USER=agent -e POSTGRES_DB=agent_tasks -p 55432:5432 postgres:17-alpine
export TEST_DATABASE_URL=postgres://agent:agent@127.0.0.1:55432/agent_tasks
DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate
pnpm test:integration
```

Every integration file truncates the database at the start, so files run sequentially
(`fileParallelism: false`) and never share state.

## Test environment variables

| Variable | Used by | Default | Required |
| --- | --- | --- | --- |
| `TEST_DATABASE_URL` | integration harness | `DATABASE_URL`, then `postgres://agent:agent@dind:55432/agent_tasks` | no, but set it explicitly |
| `E2E_BASE_URL` | Playwright | `http://localhost:8080` | no |
| `E2E_SETUP_TOKEN` | E2E setup test | — | yes when the instance has no administrator |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | E2E login test | — | yes when the instance is already configured |
| `CI` | Playwright config | unset | no; a non-empty value enables one retry |

## Browser E2E

`e2e/` drives the real UI with Playwright against the compose stack. The stack
needs the secrets from [DEPLOYMENT.md](DEPLOYMENT.md); `E2E_SETUP_TOKEN` must be the
same value as the stack's `SETUP_TOKEN`.

```bash
docker compose --profile search up -d --build
E2E_BASE_URL=http://localhost:8080 E2E_SETUP_TOKEN=<SETUP_TOKEN> pnpm test:e2e
# already-configured instance:
E2E_BASE_URL=http://localhost:8080 E2E_ADMIN_EMAIL=<admin> E2E_ADMIN_PASSWORD=<password> pnpm test:e2e
```

The suite starts `packages/mock-openai` and registers it as an
`openai-compatible` provider with a declared model. It binds a loopback port on
the test host; a remote Docker daemon needs a reachable address, so that topology
is not covered by the current helper.

## Determinism

- Unit and integration provider tests use `packages/mock-openai` and the OpenCode Go
  fixture: real HTTP servers that enforce the client contract (User-Agent, session
  header) and answer deterministically.
- The browser E2E registers `packages/mock-openai` as an `openai-compatible`
  provider, so the production provider path is exercised, not the legacy adapter.
- Search is either a fixture provider or disabled; the page fetch uses the real
  network, so the "research" assertion is honest.
- No test depends on wall-clock luck: DST cases use fixed instants.

## CI

GitHub Actions runs lint, typecheck, unit, integration (Postgres service), browser E2E
(compose), image builds, Trivy and gitleaks. See `.github/workflows/ci.yml`.
