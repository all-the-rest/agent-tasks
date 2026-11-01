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

The isolated E2E stack keeps a local stack running and has its own ports, project
name and volumes. It generates matching `SETUP_TOKEN`/`E2E_SETUP_TOKEN` and
`ADMIN_PASSWORD`/`E2E_ADMIN_PASSWORD` values on first use:

```bash
deployment/stack.sh e2e --profile mail --profile search up -d --build
( set -a; . deployment/env/e2e.env; set +a; pnpm test:e2e )
```

See [`deployment/README.md`](deployment/README.md) for the stack layout.

The suite starts `packages/mock-openai` and registers it as an
`openai-compatible` provider with a declared model. It binds a loopback port on
the test host; a remote Docker daemon needs a reachable address, so that topology
is not covered by the current helper.

The browser suite is deliberately order-independent (the shared stack still uses one Playwright worker): `beforeAll` bootstraps the
administrator and the mock provider only, every test opens its own browser
context, and tasks and global memories created by a test are registered with the
`cleanup` fixture and deleted even when an assertion fails. Accepted invitation
users cannot be deleted through the product API, so those tests use unique
addresses and create no tasks under the invited account.

## Memory tests

- `packages/shared/test/memory.test.ts` and
  `packages/agent-runtime/test/memory-tools.test.ts` cover command parsing,
  duplicate detection, secret rejection, context budgeting, tool validation and
  prompt precedence.
- `test/integration/memory.test.ts` covers CRUD, cross-session persistence,
  multi-user and cross-task isolation, `/learn`/`/update`/`/forget`, facade
  confirmation, search-index invalidation, export, concurrency, suggestions,
  recommendation decisions, cascade deletion and migration idempotence.
- `test/integration/memory-execution.test.ts` runs the real executor against the
  deterministic model endpoint repeatedly (and after edit/delete): it asserts the
  second system prompt contains the prior task memory, updated memory wins over
  automatic learning, deleted memory is not restored over two further runs, and
  recommendations are deduplicated.

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

## Transactional mail (Mailpit + SpamAssassin)

```bash
docker compose --profile mail up -d
SMTP_URL=smtp://mailpit:1025 docker compose up -d api   # or run the API on the host
MAIL_TO=admin@example.com MAILPIT_URL=http://localhost:8025 \
  node scripts/check-mailpit.mjs
```

The script requests a password reset, waits for the message in Mailpit, asserts a
plain-text part plus a complete HTML document, checks the SpamAssassin score
reported by `GET /api/v1/message/{id}/sa-check` (`Score < 5`, `IsSpam=false`), and
checks the HTML compatibility report from `GET /api/v1/message/{id}/html-check`
(default thresholds: supported ≥ 85 %, unsupported ≤ 2 %, warnings ≤ 12).

`node scripts/verify-mail-ui.mjs` additionally renders the message in Mailpit's
web UI with Playwright, asserts the heading/CTA/two reset links and writes
`mail-preview.png` (CI uploads it as an artifact).
