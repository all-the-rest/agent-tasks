# OpenCode runtime isolation: decision and integration boundary

**Decision (2026-11-03): GO for the isolated runtime foundation; production
cutover stays gated.** `OPENCODE_RUNTIME_ENABLED` remains unset or `0` until the
gates below are proven with a real OpenCode Go key. The flag is not a fallback to
the existing runtime.

## What the foundation now proves

- **Single configuration source.** The shared OpenCode Go connection, its key and
  its model catalog are written only through the admin API/UI. `OPENCODE_GO_*`
  environment seeding is gone, so no deployment file carries an inference secret.
  The admin provider card shows the discovered catalog.
- **One egress exit.** `opencode` and `opencode-runtime` are internal Docker
  networks; only the provisioner joins `opencode-egress`. The runtime container is
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
- **Structured output through tools.** A worker-hosted MCP endpoint exposes an
  explicit allowlist with a per-execution bearer token and call budget. The
  provisioner registers it as a remote MCP server (`codemode: false`) and proxies
  `/mcp`; the runtime never reaches the worker directly. `compose_email` and
  `add_email_block` reuse the product's validated DSL and block schema, and the
  runner merges the resulting blocks into the execution result.
- **MCP visibility, proven live.** OpenCode namespaces MCP tools as
  `agent_tasks_tools_<tool>`, lists them only when the model declares
  `tool_call: true`, and drops them if the session request carries a deny-all
  permission list. The runtime config therefore allows exactly the namespaced
  tools after the wildcard deny, and the client no longer sends session
  permissions. The opt-in live test starts a real OpenCode 2.2.5, waits for
  `/api/mcp` to report `connected` before creating the session, calls
  `agent_tasks_tools_compose_email` and asserts the validated blocks.

## Gates still open before cutover

1. **Real Go credential.** Every live check so far used a fake OpenAI-compatible
   provider. The shared connection must be validated against a real OpenCode Go
   account, including model ids, context limits and allowance accounting.
2. **MCP visibility in the deployed image.** Proven locally against OpenCode
   2.2.5 (tool offered, called, result persisted as validated blocks). Still to
   confirm inside the production runtime image during the live-credential run.
3. **Research, sources and memory parity.** Web research and memory are still
   rejected by the isolated runner. They need bridge tools with the same egress,
   SSRF and memory-policy controls as `packages/agent-runtime`.
4. **Report parity with real sessions.** The report page, sanitized markdown and
   report e-mail render from the durable result, but a full OpenCode run has not yet
   produced sources, usage and blocks end-to-end.
5. **Live secret handling.** The provisioner passes secrets through runtime-only
   files and environment variables, never persistent config or logs. Rotation and
   revocation of the shared key must be exercised against the live provisioner.

## Ownership and boundary

Agent Tasks remains authoritative for users, tasks, schedules, queues, leases,
quotas, retries, cancellation, audit, notifications, and durable reports. The web
app continues to use the authenticated Agent Tasks API/BFF. OpenCode stays private
to trusted backend services; session IDs are not authorization, and browser code
never receives OpenCode server credentials.

The worker resolves credentials under the task owner, verifies that task and
execution owners match, and checks the active execution lease before passing
provider context to the provisioner. Those checks do not replace the isolation
boundary. Secret material never enters persistent runtime config, logs or
untrusted transport. Native Go Connect is not used as the store of record: the
encrypted Agent Tasks credential remains authoritative and the runtime receives a
short-lived value.

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
