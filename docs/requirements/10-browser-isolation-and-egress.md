# Browser isolation and network-level egress policy (SSRF, DNS rebinding)

_Labels: security_

## Goal

Chromium must not become a pivot into the host or the private network.

## Acceptance criteria

- [x] Separate service, non-root, no capabilities, read-only root, pids/memory limits
- [x] No published port, no Docker socket, no host networking
- [x] Chromium sandbox enabled in the supported deployment
- [x] Fresh `BrowserContext` per execution, downloads disabled, non-http(s) aborted
- [x] Enforcing proxy: Chromium cannot resolve names; the proxy resolves, checks all answers, pins the checked IP
- [x] Blocks loopback, RFC1918, link-local, metadata, CGNAT, multicast, reserved, IPv6 loopback/link-local/ULA, IPv4-mapped and NAT64 forms
- [x] Every redirect hop re-validated
- [x] Session closed after execution (regression test for the DELETE 400 that leaked sessions)

## Evidence

- `services/browser-runner/test/egress.test.ts` (9 tests incl. rebinding and redirect fixtures).
- `docs/security/browser-isolation.md`.
- Sandbox could not be exercised on this host (no user namespaces); see VERIFICATION_REPORT.
