#!/usr/bin/env node
/**
 * Writes the requirement documents under docs/requirements/. Each file is the body
 * of the matching GitHub issue; `scripts/publish-issues.sh` creates them.
 *
 * Keeping the bodies in the repository means the requirements are versioned with
 * the code that claims to implement them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const issues = [
  {
    slug: '01-repository-and-ci',
    title: 'Repository, license, workspace layout and CI',
    labels: ['deploy'],
    body: `## Goal

A public, Apache-2.0 TypeScript monorepo under \`all-the-rest/agent-tasks\` with a pnpm
workspace, reproducible builds and CI that fails on a red gate.

## Acceptance criteria

- [x] pnpm workspace with \`apps/{web,api,worker}\`, \`services/browser-runner\`, \`packages/{shared,database,ai-providers,agent-runtime,browser-tools,mock-openai}\`
- [x] Shared versions through a pnpm catalog instead of duplicated semver ranges
- [x] Apache-2.0 license, README, CHANGELOG, CONTRIBUTING
- [x] Strict TypeScript, \`pnpm typecheck\` for every project
- [x] ESLint flat config, \`pnpm lint\`
- [x] GitHub Actions: lint, typecheck, unit, integration (Postgres service), browser E2E, image build, Trivy, gitleaks
- [x] Repository-local hooks (\`.githooks/pre-commit\`): secret scan, ratchet gates, lint, typecheck, codegraph sync
- [x] \`ratchet\` quality gates with a committed baseline

## Evidence

\`\`\`
pnpm typecheck   # 10 projects, exit 0
pnpm lint        # exit 0
ratchet check    # 5 of 5 gates passed
\`\`\`

Workflows: \`.github/workflows/ci.yml\`.
`,
  },
  {
    slug: '02-authentication-and-roles',
    title: 'Authentication, roles and account lifecycle',
    labels: ['security'],
    body: `## Goal

Secure, invite-only authentication with exactly two roles and no default credentials.

## Acceptance criteria

- [x] Better Auth with email/password, minimum password length 12
- [x] Public registration disabled; onboarding only through single-use invitations (7 days)
- [x] First-admin bootstrap with a deployment-provided \`SETUP_TOKEN\`, refused once an admin exists
- [x] Session revocation: sign-out is effective on the next request (no cookie session cache)
- [x] TOTP MFA with backup codes, verified before activation
- [x] Rate limits on sign-in, TOTP verification, password reset and sign-up
- [x] Password reset and email verification through a real SMTP transport (log transport in development)
- [x] Admin-only user management: role change, deactivation, last-admin guard
- [x] Audit log for every sensitive administrative operation
- [x] CSRF: Better Auth origin checks plus an explicit origin guard on app routes

## Evidence

- \`test/integration/auth.test.ts\` (10 tests): setup token, single admin, logout, indistinguishable
  401s, blocked direct sign-up, invite reuse, CSRF, real TOTP flow, 429.
- \`apps/api/src/auth.ts\`, \`apps/api/src/app.ts\`, \`apps/api/src/routes/setup.ts\`.
`,
  },
  {
    slug: '03-multi-user-isolation',
    title: 'Strict multi-user isolation and horizontal authorization',
    labels: ['security'],
    body: `## Goal

No user can reach another user's tasks, executions, reports, logs, artifacts or
credentials — by id, body, or role.

## Acceptance criteria

- [x] Every query is scoped with \`owner_id = session.user.id\`
- [x] Client-supplied \`ownerId\`/\`id\` is ignored on create
- [x] Malformed ids return 404 instead of a database error
- [x] Administrator role grants no access to user tasks, executions or credentials
- [x] Personal provider credentials are per-owner; a shared credential is explicit
- [x] Background execution re-derives ownership from the task row

## Evidence

\`test/integration/isolation.test.ts\` (8 tests): cross-user read/write/run/pause, execution
read/cancel/export/history, admin bypass attempts, credential isolation, forged owner ids,
last-admin guard, revoked invitation.
`,
  },
  {
    slug: '04-task-management-and-timezones',
    title: 'Task management, scheduling presets and timezone/DST correctness',
    labels: [],
    body: `## Goal

Complete task lifecycle with timezone-aware schedules that survive DST changes.

## Acceptance criteria

- [x] Task fields: title, description, prompt, system instructions, provider, model, enabled, schedule, timezone, limits, research permission, notification preference
- [x] CRUD, pause/resume, run-now, duplicate, execution history
- [x] Presets: once, daily, selected weekdays, weekly, monthly, custom cron
- [x] Timestamps stored in UTC; schedule evaluated in the task's IANA zone
- [x] Spring-forward gap: a 02:30 job runs at 03:30 local instead of being dropped
- [x] Fall-back overlap: the job runs once, at the first (CEST) instant
- [x] Limits are capped by hard maxima and enforced in the agent loop

## Evidence

- \`packages/shared/test/schedule.test.ts\` (DST cases with fixed instants, Europe/Vienna).
- \`apps/api/src/routes/tasks.ts\`, \`packages/shared/src/schedule.ts\`.
`,
  },
  {
    slug: '05-durable-scheduling',
    title: 'Durable scheduling: pg-boss, leases, retries, cancellation, recovery',
    labels: [],
    body: `## Goal

Recurring tasks survive restarts and never double-book an occurrence.

## Acceptance criteria

- [x] pg-boss queues for the tick, the recovery sweep and each execution
- [x] Transactional booking: \`FOR UPDATE SKIP LOCKED\` + unique \`(task_id, scheduled_for)\`
- [x] Multiple workers safe against each other (claim flips \`queued → running\`)
- [x] Execution leases and crash recovery (requeue, or cancel when cancellation was requested)
- [x] Retries with backoff for transient provider failures (max 3 attempts)
- [x] Execution timeouts and cancellation polling
- [x] Per-user concurrency and daily quota
- [x] Graceful shutdown aborts running executions
- [x] Documented at-least-once semantics

## Evidence

\`test/integration/scheduler.test.ts\` (6 tests): single booking, idempotent tick, concurrent
ticks, paused tasks, database-level duplicate rejection, single claim, stale-lease recovery.
`,
  },
  {
    slug: '06-ai-providers',
    title: 'AI providers: Ollama, OpenAI-compatible (OpenCode Go contract), mock endpoint',
    labels: ['testing'],
    body: `## Goal

A provider-neutral interface where local inference works without any paid subscription.

## Acceptance criteria

- [x] Ollama adapter: model discovery, capability check, tool calling, timeouts, clear errors
- [x] A model without the \`tools\` capability is refused instead of silently degraded
- [x] OpenAI-compatible adapter with configurable base URL, extra headers and timeouts
- [x] Sends an honest \`User-Agent\` and a stable \`x-opencode-session\` per conversation (OpenCode Go requirements)
- [x] Records \`opencode.allowance\` usage where the endpoint reports it
- [x] Model tool support is declared, never assumed
- [x] \`packages/mock-openai\`: a real HTTP server that enforces the client contract
- [x] Credentials are per-user or explicitly shared; never sent to the browser runner

## Evidence

\`packages/ai-providers/test/openai-compatible.test.ts\` drives the adapter against the mock
server: tool calls, usage, allowance, 401 mapping, generic User-Agent rejected, missing session
header rejected.

Open question: a real Ollama run needs model hardware and is not executed in this
environment (see VERIFICATION_REPORT).
`,
  },
  {
    slug: '07-codex-adapter',
    title: 'Codex / ChatGPT integration: only official, account-scoped paths',
    labels: ['security'],
    body: `## Goal

Investigate an officially supported Codex path without turning a personal ChatGPT
subscription into shared multi-user inference.

## Decision

- [x] Adapter exists but is **disabled by default** (\`AGENT_TASKS_ENABLE_CODEX=1\` + provider flag)
- [x] Account-scoped: per-user \`CODEX_HOME\`, no shared accounts
- [x] No browser cookies, no undocumented endpoints, no token extraction
- [x] Text-only: refuses tool calling instead of pretending research happened
- [x] Documented limitation: ChatGPT Go is not OpenAI API credit

## Evidence

\`packages/ai-providers/src/codex.ts\`, \`docs/architecture/providers.md\`.
Not verified against a live Codex account in this environment.
`,
  },
  {
    slug: '08-agent-runtime',
    title: 'Agent runtime: validated tools, limits, structured results',
    labels: ['security'],
    body: `## Goal

A real execution loop that researches instead of answering from memory.

## Acceptance criteria

- [x] Tools: \`search_web\`, \`open_url\`, \`extract_page_text\`, \`inspect_page\`, \`click_element\`, \`fill_form\`, \`navigate_back\`, \`get_page_title\`, \`get_current_url\`, \`extract_links\`
- [x] No shell, no arbitrary JavaScript, no file system access
- [x] Every call validated against a schema and an allowlist; unknown tools are refused
- [x] Task limits enforced per step, tool call, page visit, search query, output size, duration
- [x] Retrieved content wrapped as untrusted data
- [x] Sources collected, deduplicated and persisted with confidence labels
- [x] Final answer stored as Markdown with summary, sources and uncertainty

## Evidence

\`packages/agent-runtime/test/runtime.test.ts\` (7 tests) and the end-to-end execution test
(real Chromium, real page, persisted report).
`,
  },
  {
    slug: '09-web-research',
    title: 'Web research with a configurable, documented search backend',
    labels: [],
    body: `## Goal

Actual discovery and page reading, not model recall.

## Acceptance criteria

- [x] SearXNG JSON adapter (self-hosted, no commercial key) with a composable interface
- [x] Fixture and no-op providers for deterministic tests
- [x] Visited URLs, timestamps, titles and excerpts recorded per execution
- [x] Inaccessible pages reported honestly as errors, not invented content
- [x] Domain/redirect validation in the browser layer
- [ ] Respect robots.txt/tos per site — documented as an operator responsibility, not enforced
- [ ] Captcha/paywall bypass — explicitly out of scope

## Evidence

\`packages/browser-tools/src/search.ts\`, \`test/integration/execution.test.ts\` (real page fetch),
\`docker/searxng/settings.yml\`.
`,
  },
  {
    slug: '10-browser-isolation-and-egress',
    title: 'Browser isolation and network-level egress policy (SSRF, DNS rebinding)',
    labels: ['security'],
    body: `## Goal

Chromium must not become a pivot into the host or the private network.

## Acceptance criteria

- [x] Separate service, non-root, no capabilities, read-only root, pids/memory limits
- [x] No published port, no Docker socket, no host networking
- [x] Chromium sandbox enabled in the supported deployment
- [x] Fresh \`BrowserContext\` per execution, downloads disabled, non-http(s) aborted
- [x] Enforcing proxy: Chromium cannot resolve names; the proxy resolves, checks all answers, pins the checked IP
- [x] Blocks loopback, RFC1918, link-local, metadata, CGNAT, multicast, reserved, IPv6 loopback/link-local/ULA, IPv4-mapped and NAT64 forms
- [x] Every redirect hop re-validated
- [x] Session closed after execution (regression test for the DELETE 400 that leaked sessions)

## Evidence

- \`services/browser-runner/test/egress.test.ts\` (7 tests incl. rebinding fixture).
- \`docs/security/browser-isolation.md\`.
- Sandbox could not be exercised on this host (no user namespaces); see VERIFICATION_REPORT.
`,
  },
  {
    slug: '11-prompt-injection-and-xss',
    title: 'Prompt injection, stored XSS, CSRF and secret leaks',
    labels: ['security'],
    body: `## Goal

Assume every page is hostile and every report is untrusted output.

## Acceptance criteria

- [x] System prompt, user prompt and retrieved content separated; web text labelled untrusted
- [x] No execution of model-generated code, shell commands or unrestricted requests
- [x] Clicks on login/checkout/payment/destructive controls refused by the runner
- [x] Form submission disabled by policy
- [x] Markdown rendered through \`rehype-sanitize\`; no raw HTML sink (ratchet gate)
- [x] Origin guard on state-changing app routes
- [x] Secret redaction in logs, errors and provider failure messages
- [x] Credentials never returned by any API response

## Evidence

Agent-runtime injection test, isolation/CSRF tests, ratchet gates \`no-raw-html\` and
\`no-baked-secret\`.
`,
  },
  {
    slug: '12-reports-and-exports',
    title: 'Results, reports and exports',
    labels: [],
    body: `## Acceptance criteria

- [x] Execution metadata, tool-call timeline, sources, Markdown report, usage, sanitized errors
- [x] Markdown + JSON export with \`Content-Disposition: attachment\`
- [x] Clickable sources with retrieval timestamps and confidence
- [x] No invented links: sources come from tool results only
- [x] Historical comparison through the execution list per task

## Evidence

\`apps/api/src/routes/tasks.ts\` (detail + export), \`packages/shared/src/report.ts\`,
\`apps/web/src/pages/ExecutionDetailPage.tsx\`.
`,
  },
  {
    slug: '13-web-ui',
    title: 'Web UI: pages, accessibility, i18n (en/de), daisyUI',
    labels: [],
    body: `## Acceptance criteria

- [x] Login, setup, invite, dashboard, tasks, task editor, scheduling, executions, execution detail, settings, admin (users, providers, audit, monitoring)
- [x] Responsive layout, daisyUI components, Tailwind v4
- [x] Full English and German catalogues, language persisted locally
- [x] Accessible controls, labels, loading/error/empty states
- [x] Markdown report rendered sanitized
- [ ] E2E against the real API — covered by the Playwright suite in CI, not yet run locally

## Evidence

\`pnpm --filter @agent-tasks/web build\` and \`typecheck\` exit 0; 15 UI unit tests.
`,
  },
  {
    slug: '14-deployment-and-operations',
    title: 'Docker Compose deployment, Portainer auto-update, documentation',
    labels: ['deploy', 'docs'],
    body: `## Acceptance criteria

- [x] Compose stack: web, api, worker, postgres, hardened browser runner
- [x] Optional profiles: SearXNG (search), Ollama (local-ai)
- [x] Named volumes, health checks, restart policies, no published database port
- [x] Pinned images, minimal privileges, seccomp profile
- [x] Watchtower labels for api/worker/web only
- [x] README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, .env.example
- [ ] Full compose start verified in this environment (Docker daemon is remote; see VERIFICATION_REPORT)

## Evidence

\`compose.yaml\`, \`docker/\`, \`DEPLOYMENT.md\`.
`,
  },
];

mkdirSync('docs/requirements', { recursive: true });
for (const issue of issues) {
  const front = `# ${issue.title}\n\n_Labels: ${issue.labels.join(', ') || 'none'}_\n\n`;
  writeFileSync(`docs/requirements/${issue.slug}.md`, `${front}${issue.body}`);
}
writeFileSync('/tmp/agent-tasks-issues.json', JSON.stringify(issues.map(({ slug, title, labels }) => ({ slug, title, labels })), null, 2));
console.log(`wrote ${issues.length} requirement documents`);
