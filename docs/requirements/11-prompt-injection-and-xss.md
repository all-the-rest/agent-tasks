# Prompt injection, stored XSS, CSRF and secret leaks

_Labels: security_

## Goal

Assume every page is hostile and every report is untrusted output.

## Acceptance criteria

- [x] System prompt, user prompt and retrieved content separated; web text labelled untrusted
- [x] No execution of model-generated code, shell commands or unrestricted requests
- [x] Clicks on login/checkout/payment/destructive controls refused by the runner
- [x] Form submission disabled by policy
- [x] Markdown rendered through `rehype-sanitize`; no raw HTML sink (ratchet gate)
- [x] Origin guard on state-changing app routes
- [x] Secret redaction in logs, errors and provider failure messages
- [x] Credentials never returned by any API response

## Evidence

Agent-runtime injection test, `services/browser-runner/test/click-policy.test.ts`
(English/German sensitive controls, phrase boundaries, sensitive link/page/form
routes), `services/browser-runner/test/browser-click-policy.test.ts` (runner dispatch
refuses sensitive form targets), isolation/CSRF tests, and ratchet gates `no-raw-html`
and `no-baked-secret`.
