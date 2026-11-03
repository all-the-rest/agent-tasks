# OpenCode runtime isolation: integration boundary

`OPENCODE_RUNTIME_ENABLED` is off when absent or set to `0`. Setting it to `1`
without an explicitly wired isolated runner makes the worker fail at startup;
the deployed worker currently has no such provisioner. Do not enable this flag
in deployment yet. It is intentionally not a fallback to the existing runtime.

The experimental runner only handles text-only executions without memory or
e-mail. It does not yet provide the product's tool, usage, or research parity.
The flag is not evidence that these features or tenant isolation are available.

Before this can be enabled, a trusted `IsolatedOpenCodeProvisioner` must provide:

- A separate OS/container security boundary and private data, configuration,
  credentials, process and network scope for every execution. A separate
  directory, session or shared OpenCode server is not an isolation boundary.
- Authenticated communication accessible only to the worker; no public or
  browser access, Docker socket exposure, or shared credential activation.
- Reconnection to the same private durable session state following worker
  recovery; release of a connection must not delete recoverable state.
- Explicit bounded teardown, cleanup, resource controls, egress restrictions,
  backup, redaction and tests proving cross-owner isolation and credential scope.

The worker resolves the provider credential using the task owner, verifies that
the execution and task owners match, and checks the execution's owner and active
lease before passing the resulting provider context to the provisioner. Those
checks do not replace a real isolation boundary. The provisioner receives secret
material and must not log it or pass it through an untrusted transport.

The session mapping is persisted before prompt dispatch. If a worker dies after
marking dispatch but before actually sending the request, recovery cannot know
whether the prompt was accepted. It does not resend automatically; this avoids a
duplicate run at the cost of a potentially unresolved execution.
