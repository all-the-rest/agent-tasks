# OpenCode runtime isolation: decision and integration boundary

**Decision (2026-11-03): OpenCode is the worker's only execution backend;
production activation stays gated.** Local and CI execution use a test-only fake
provisioner. The production example intentionally leaves
`OPENCODE_PROVISIONER_TOKEN` empty, and `deployment/deploy.sh` refuses every real
deploy while the source-controlled marker
`deployment/OPENCODE_RUNTIME_APPROVED` is absent, before it contacts the host.
That marker is a deliberate part of the reviewed change that closes the gates
below — no `.env` value, token or profile can bypass it. The preflight separately
rejects the `opencode-runtime` profile and an empty worker provisioner token, so
a deploy cannot leave a worker restart loop.

## What the foundation now proves

- **Single configuration source.** The shared OpenCode Go connection, its key and
  its model catalog are written only through the admin API/UI. `OPENCODE_GO_*`
  environment seeding is gone, so no deployment file carries an inference secret.
  The admin provider card shows the discovered catalog, marks one model as the
  default for new tasks, can hide models from the task editor, reports the last
  health check and links to the audit log. Hide/default are provider config, not
  catalog rows, so a model refresh never loses the administrator's choice.
- **One persisted catalog, explicit capability.** The worker and the provisioner
  read the same catalog the task editor shows: the discovered `provider_models`
  rows merged with the administrator's `config.models` metadata overrides, so a
  discovered model is usable without a duplicated declaration and a declared
  model survives a refresh. Tool support is never inferred from discovery — the
  OpenAI `/models` route cannot express it. Only an explicit
  `supportsTools: true` marks a model tool-capable, via the admin toggle that
  writes `config.models`. Research, e-mail and memory tasks are refused with a
  clear 400 before provisioning when the model lacks that flag; the worker, the
  runner and the provisioner repeat the check so no path silently runs a task
  without its tools.
- **Unsupported provider kinds are refused, not remapped.** Only
  `openai-compatible` executes. The API returns 400 for task creation, an
  execution-relevant update or a manual run on any other kind, and marks those
  providers `executable: false` while keeping their rows and credentials intact.
- **One egress exit.** `opencode-runtime` is an internal Docker network with no
  shared OpenCode service; only the provisioner joins `opencode-egress`. The runtime container is
  never published and has no direct route out. Inference traffic crosses the
  provisioner, which is the audited boundary.
- **Per-execution isolation.** The provisioner creates a private internal network,
  data and config volumes, a non-root runtime, owner-only secret files and a
  bounded container. Session state survives container recreation for the same
  execution and is denied to other executions (`scripts/verify-opencode-provisioner.mjs`).
- **Idempotent recovery.** The message ID is persisted before dispatch. A recovered
  worker first reads the durable assistant message; if none exists it replays the
  prompt with the same ID and treats OpenCode's HTTP 409 as "already accepted".
  A first dispatch rejected without a durable message fails closed. Execution steps
  are replaced by step number, so reconciliation cannot duplicate rows. Unit tests
  cover recovery, replay, fail-closed and cancellation-interrupt; the integration
  test exercises the real session store.
- **Model variants survive the boundary.** `model#variant` is split in the
  worker before provisioning: the provisioner validates the base id against the
  merged persisted catalog, declares all six variants on the runtime model and returns
  the accepted variant. The client and runner both reject a dropped or rewritten
  variant, so a reasoning selection is never silently lost. The opt-in live test
  runs real OpenCode 2.2.5 for every variant and asserts the provider request
  carries the matching `reasoning_effort`.
- **Structured output through tools.** A worker-hosted MCP endpoint exposes an
  explicit allowlist with a per-execution bearer token and call budget. The
  provisioner registers it as a remote MCP server (`codemode: false`) and proxies
  `/mcp`; the runtime never reaches the worker directly. `compose_email` and
  `add_email_block` reuse the product's validated DSL and block schema, and the
  runner merges the resulting blocks into the execution result.
- **Research and memory through the same boundary.** When the task allows it, the
  bridge also offers `search_web`, `open_url`, the page-inspection tools,
  `record_task_memory` and `track_recommendation`. It receives the execution's
  browser and search capability, collects verified sources and validated memory
  proposals, and the runner merges them into the result the Executor persists.
- **One report shape for page and mail.** The execution page renders the
  sanitized markdown, sources and a safe React preview of the notification e-mail
  blocks; the same blocks feed `renderEmailDocument`. Blocks are never injected as
  raw HTML, and only http(s) URLs reach links or images.
- **MCP visibility, proven live.** OpenCode namespaces MCP tools as
  `agent_tasks_tools_<tool>`, lists them only when the model declares
  `tool_call: true`, and drops them if the session request carries a deny-all
  permission list. The runtime config therefore allows exactly the namespaced
  tools after the wildcard deny, and the client no longer sends session
  permissions. The opt-in live test starts a real OpenCode 2.2.5, waits for
  `/api/mcp` to report `connected` before creating the session, calls
  `agent_tasks_tools_compose_email` and asserts the validated blocks.

## Gates still open before cutover

The provisioner's production provider proxy resolves the upstream hostname and
rejects private and loopback addresses, then connects using HTTPS on port 443.
A locally hosted fake provider therefore cannot exercise that complete path
without changing the security boundary. The local OpenCode live suite uses a
fake provider; the e-mail test routes MCP through the actual provisioner proxy
to the worker bridge. It does not prove the production-image provider proxy,
container-to-container MCP forwarding, or provider-side credential rotation and
revocation. These gates remain open until they can be tested
with an appropriately reachable HTTPS provider and actual runtime images.
The worker's provisioner request now includes the MCP capability and serializes
the model as the object expected by the provisioner. Focused tests cover this
request contract; they do not replace an end-to-end model invocation.

1. **Real Go credential.** Every live check so far used a fake OpenAI-compatible
   provider. The shared connection must be validated against a real OpenCode Go
   account, including model ids, context limits and allowance accounting.
2. **MCP visibility in the deployed image.** Proven locally against OpenCode
   2.2.5 using the provisioner's exact `runtimeConfig` output (policies,
   `tool_call`, namespaced permission allows); only the MCP URL points at the
   in-process hub. Still to confirm inside the production runtime image during the
   live-credential run.
3. **Research, sources and memory parity.** The bridge now offers the same
   research and memory tools as `packages/agent-runtime` (`search_web`, `open_url`,
   page inspection, `record_task_memory`, `track_recommendation`) and collects
   their validated output. The opt-in live run opens a page and persists the
   source. Still to confirm under the production egress proxy/SSRF controls.
4. **Report parity with real sessions.** The report page, sanitized markdown and
   report e-mail render from the durable result. A local OpenCode 2.2.5 run now
   produces sources and e-mail blocks end-to-end; usage is summed over the
   session's per-turn assistant messages, but real counters require a live
   provider. A real Go run is still needed.
5. **Live secret handling.** The provisioner passes secrets through runtime-only
   files and environment variables, never persistent config or logs. Rotation and
   revocation of the shared key must be exercised against the live provisioner.

## Ownership and boundary

Agent Tasks remains authoritative for users, tasks, schedules, queues, leases,
quotas, retries, cancellation, audit, notifications, and durable reports. The web
app continues to use the authenticated Agent Tasks API/BFF. OpenCode stays private
to trusted backend services; session IDs are not authorization, and browser code
never receives OpenCode server credentials.

The separate [OpenCode Web research](opencode-web-research.md) records why the
OpenCode Web UI is not an Agent Tasks integration surface and why its experimental,
session-bound schedules do not replace the product scheduler.

The worker resolves credentials under the task owner, verifies that task and
execution owners match, and checks the active execution lease before passing
provider context to the provisioner. Those checks do not replace the isolation
boundary. Secret material never enters persistent runtime config, logs or
untrusted transport. Native Go Connect is not used as the store of record: the
encrypted Agent Tasks credential remains authoritative and the runtime receives a
short-lived value.

## Tool bridge protocol and threat model

The bridge is a worker-hosted MCP server. OpenCode sends JSON-RPC 2.0 over
`POST /mcp`; each reply is an SSE `event: message` frame. The server-initiated
`GET` stream is declined with `405`, which OpenCode 2.2.5 tolerates, and every
response echoes `mcp-session-id` so the transport stays correlated.

- **Token lifecycle.** A random 32-byte bearer is minted in worker memory when the
  execution opens its bridge, registered with that session's allowlist and call
  policy, and handed to the provisioner only as runtime configuration. Budget
  counters are atomically reserved against the execution row in PostgreSQL, not
  reset with a bridge process; the stored maxima can only stay the same or tighten
  across retries and recovery. The bearer itself is never
  written to the database, a report or a log. It expires after one hour, comfortably
  above the maximum execution duration, and expiry is checked on every request, so an
  execution whose bridge was never closed cannot leave a usable token behind. Closing
  the execution removes the session immediately; either way a later request gets
  `401`.
- **Allowlist and budget.** Only the exact tools the task is entitled to are
  registered. Every authenticated tool call, including malformed or disallowed
  calls, consumes the durable call budget before dispatch; page visits and searches
  are reserved before their side effects. Exhausted calls are refused without a
  timeline row, so refusals cannot amplify storage. Database/lease failures fail
  closed. Request bodies are size-capped and error replies carry no stack traces or
  configuration.
- **Capability, not ambient authority.** Research tools are registered only when
  the bridge received the execution's browser and search clients; otherwise
  `open()` fails. URLs pass the same `checkUrl` policy as the native runtime, page
  text is treated as data, each tool reply is byte-capped, and the total output
  returned to OpenCode is accounted against a cumulative per-execution budget.
- **Validated writes and timeline.** E-mail blocks are parsed from the product DSL,
  memory operations are schema-checked and secret-scanned, and recommendations
  cannot set a user decision. The bridge never writes to the database. The Executor
  persists redacted, bounded tool-call steps as they occur; memory/recommendation
  arguments and results are deliberately omitted from history so later edits or
  deletion cannot leave their content in the timeline. Validated sources, e-mail
  blocks, memory operations and recommendations are applied only after success.

## Recovery contract

The session mapping and message ID are persisted before prompt dispatch. On
recovery the runner:

1. reads the session's durable messages and returns the first finished assistant
   message without sending anything;
2. otherwise replays the prompt with the persisted message ID;
3. maps HTTP 409 to "already accepted" and waits for the durable message;
4. fails closed if the first dispatch is rejected and no durable message exists.

Cancellation interrupts the OpenCode session and surfaces as cancelled, not
failed. A timeout is terminal and never retried.

## Version, persistence and operations

- **Pinned version.** `docker/Dockerfile.opencode` pins `OPENCODE_VERSION=2.2.5`;
  the compose image is the only supported runtime. The V2 HTTP API is experimental,
  so the contract tests (`apps/worker/test/opencode-v2-*.test.ts`) and the opt-in
  live suite run against that exact binary. A version bump re-runs the live suite
  before the image tag changes.
- **Persistence.** OpenCode state lives in per-execution volumes (`data`, `config`,
  `state`) and is reattached when the same execution reopens its runtime. The
  volumes are cleaned by the provisioner after `OPENCODE_RUNTIME_TTL_SECONDS`
  (default 30 days). Postgres remains the system of record: the session mapping,
  durable message ID, steps, sources, report and usage are stored there, so a lost
  runtime volume only forces a fresh session, never a lost report.
- **Backup/restore.** The production backup covers the Postgres volume and `.env`;
  OpenCode volumes are reproducible execution scratch space and are deliberately
  not part of the backup contract. Restoring Postgres restores every user-visible
  result; an interrupted execution is retried or reconciled against its persisted
  message by the runner.
- **Logs and redaction.** Provider keys exist only in runtime tmpfs files and
  `{env:…}` references in the persistent config. The provisioner never logs request
  bodies; bridge errors carry no stack traces or configuration; worker step errors
  and failure messages pass through `redact` with every known secret before they
  reach the database, an API response or a notification.
- **Verification plan.** Local: `pnpm lint`, `pnpm -r typecheck`, `pnpm test:unit`,
  `TEST_DATABASE_URL=… pnpm test:integration`, `OPENCODE_LIVE_TEST=1` for the real
  2.2.5 binary, the provisioner unit tests and `scripts/verify-opencode-provisioner.mjs`
  against the rebuilt container, plus `check-compose-parity.mjs` and `ratchet check`.
  CI runs the same unit/integration suites, builds every image, executes the
  deploy dry-run and the browser E2E suite. The real-credential gates listed above
  are the only checks that cannot run in CI without a Go account.
