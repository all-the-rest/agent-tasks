# OpenCode runtime isolation: decision and integration boundary

**Decision (2026-11-03): NO-GO for production cutover.** OpenCode Go remains the
target, but the spike has not met the required authentication, secret-handling,
central-configuration, isolation, and product-parity gates. Keep
`OPENCODE_RUNTIME_ENABLED` unset or `0`; it is not a fallback and must not be
enabled in deployment.

## Findings

- OpenCode 2.2.5 exposes the `opencode-go` integration with `key` and `env`
  methods, not OAuth. Its separate `opencode` device-OAuth integration is not
  OpenCode Go. A pinned 2.2.5 server accepted the Go key-connect request, but
  stores credentials in its SQLite credential database; the credential API can
  return stored secrets. Never expose OpenCode Connect or credential endpoints
  directly to a browser.
- The spike's isolated runtime accepts OpenAI-compatible API-key credentials.
  Its fake-key container smoke does not authenticate to OpenCode Go and does not
  prove that a real Go key can be distributed safely.
- Provider/model setup is still partly environment-bootstrapped. The required
  admin-only web flow, shared Go connection, centrally approved model catalog,
  and central rotation/removal behavior are not implemented.
- The experimental runner is text-only. Tool/MCP integration, research and
  source parity, usage/accounting parity, memory, e-mail, and report parity are
  incomplete. The OpenCode V2 HTTP API is experimental.
- Session state can be durable per execution, but the container smoke is not a
  worker/Executor crash-recovery or prompt-idempotency proof. A worker can die
  after recording prompt dispatch but before learning whether OpenCode accepted
  it; the runner deliberately does not resend an ambiguous prompt.

## Ownership and boundary

Agent Tasks remains authoritative for users, tasks, schedules, queues, leases,
quotas, retries, cancellation, audit, notifications, and durable reports. The
web app must continue to use the authenticated Agent Tasks API/BFF. OpenCode
must remain private to trusted backend services; session IDs are not
authorization, and browser code must never receive OpenCode server credentials.

Before enabling the flag, a production provisioner must provide a distinct
container/security boundary and private process, network, configuration,
credential, and durable session state for each execution. It must use bounded
resources, constrained egress, authenticated worker-only communication, safe
teardown/retention, redacted diagnostics, and tests for cross-owner and
cross-execution access. A separate directory or session on a shared server is
not isolation.

The worker resolves credentials under the task owner, verifies that task and
execution owners match, and checks the active execution lease before passing
provider context to the provisioner. Those checks do not replace the isolation
boundary. Secret material must never enter persistent runtime config, logs, or
untrusted transport; native Go Connect must either use Agent Tasks' encrypted
shared credential store as its source of truth or demonstrate a safe,
short-lived transfer that avoids OpenCode's persistent plaintext credential DB.

## Recovery caveat

The session mapping is persisted before prompt dispatch. If a worker dies after
marking dispatch but before actually sending the request, recovery cannot know
whether the prompt was accepted. It does not resend automatically; this avoids a
duplicate run at the cost of a potentially unresolved execution. A production
cutover needs a tested reconciliation/idempotency contract, not only a durable
OpenCode session.
