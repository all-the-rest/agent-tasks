# Security

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Write to **security@reisinger.pictures**
with a description, affected version/commit and a reproduction. We aim to acknowledge
within 72 hours and to publish a fix and advisory within 30 days for confirmed issues.

## Assets

1. User credentials and sessions.
2. Per-user provider credentials (API keys).
3. Research results and the prompts that produced them (potentially sensitive).
4. The browser container's network position (must not become a pivot into the host).
5. The admin's ability to configure providers, limits and users.

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Browser → reverse proxy → API | HTTPS at the reverse proxy, `SameSite=Lax` cookies, origin checks; the API port binds to loopback by default |
| API → Postgres | Private compose network only, no published port, single application role |
| Worker → browser runner | Shared token (`RUNNER_TOKEN`), private compose network, no published port |
| Runner → Internet | Enforcing HTTP proxy: scheme/port allowlist, DNS resolved in the proxy, all answers must be public, connection pinned to a checked IP |
| Model → tools | Allowlist of the defined tools (nine exposed; form filling off), Zod-validated arguments, per-task limits |
| Webpage → model | Retrieved text is wrapped in `UNTRUSTED EXTERNAL CONTENT` and never treated as instructions |

## Authentication and sessions

- Public registration is disabled at the HTTP layer: `POST /api/auth/sign-up/email`
  is only forwarded with a valid, unused invite token for exactly that address.
- The first administrator is created once with a deployment-provided `SETUP_TOKEN`;
  after that the setup endpoint returns `409`.
- Passwords are hashed by Better Auth (scrypt-based) with a minimum length of 12.
- Sessions expire after 7 days, refresh after 24 hours, and are **not** cached in a
  cookie, so revocation and sign-out take effect on the next request.
- TOTP MFA is implemented through Better Auth's two-factor plugin (verified flow,
  backup codes, per-user lockout counters).
- Sign-in, TOTP verification, password reset and sign-up are rate limited; failures
  are indistinguishable for existing and non-existing accounts.
- Account deactivation is a `banned` flag checked on every authenticated request.

## Authorization

Every resource is looked up with `owner_id = session.user.id`. There is no
"admin can read everything" path: administrators see aggregates, user lists and
audit logs, not tasks, reports or credentials. Automated IDOR tests live in
`test/integration/isolation.test.ts` and cover tasks, executions, exports, history,
credentials and every admin endpoint.

Background execution re-proves ownership: the worker loads the task by id from the
database and uses `task.ownerId` — never an id from a request body.

## Secrets

- Provider credentials are encrypted with AES-256-GCM (`SECRETS_ENCRYPTION_KEY`,
  32 bytes base64). Ciphertext format `v1.iv.tag.payload`; version prefix allows
  algorithm changes.
- Rotation: set the new key in `SECRETS_ENCRYPTION_KEY`, keep the old one in
  `SECRETS_ENCRYPTION_KEY_PREVIOUS`, restart (reads still succeed), then re-save each
  credential through the UI and finally remove the previous key. **Back up the key**:
  without it, stored credentials are unrecoverable.
- Credentials are decrypted only in the worker/API process that needs them, never in
  the browser container, never sent to the model. Provider API keys are never read
  from environment variables; only the encryption key is.
- Logs redact `authorization`, `cookie`, `x-runner-token`, `x-invite-token` and
  `set-cookie`; provider error text is passed through `redact()` before storage.
- API responses never include `ciphertext`, `config.headers` values or tokens.

## SSRF and network policy

Two independent layers:

1. **Tool layer** (`packages/shared/src/net.ts`): scheme allowlist (http/https, http
   optionally disabled), port allowlist, no credentials in URLs, blocked hostnames
   (`localhost`, `*.local`, `*.internal`, `host.docker.internal`, cloud metadata),
   address classification for IPv4 and IPv6 including IPv4-mapped and NAT64 forms.
2. **Runner layer**: Chromium is started with `--proxy-server` pointing at an
   in-process proxy. The proxy resolves every hostname itself, checks *all* answers,
   and connects to the checked IP. Redirects are new proxy requests, so every hop is
   checked. The browser never resolves a name, which defeats DNS rebinding; a rebinding
   fixture is part of the test suite.

Blocked by classification: loopback, RFC1918, carrier-grade NAT, link-local,
metadata (169.254.169.254), unspecified, multicast, reserved, IPv6 loopback,
link-local, unique-local, IPv4-mapped private and NAT64 private.

**Residual risk:** a shared runner isolates by `BrowserContext`, which is not an OS
security boundary. The container (non-root, dropped capabilities, read-only root,
seccomp default profile, pids/memory limits, no Docker socket, separate network) is
the real boundary. A per-execution container launcher is the documented next step.

## Prompt injection

- System instructions, user prompt and retrieved content are separated; retrieved
  content is wrapped and labelled as data.
- The model can only call allowlisted tools; every call is validated and counted
  against the task's limits.
- The worker does not expose `fill_form` (`allowForms: false`); the runner also
  refuses clicks on login/checkout/payment/destructive controls and form submits on
  authentication or payment pages.
- The agent cannot change its own permissions, and no code path executes model output
  as code or shell.

## CSRF and XSS

- Better Auth validates `Origin` for `/api/auth/*`; the app routes reject
  state-changing requests whose `Origin` is not the configured base URL.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `COOKIE_SECURE=true`.
- Markdown reports are rendered with `rehype-sanitize`; raw HTML from a report is
  stripped. Download exports are attachments, not inline HTML.

## Known limitations

- Email verification is optional (`requireEmailVerification: false` by default).
  Invitations are addressed to the invited mailbox, but the administrator also
  receives the link, so they do not prove address ownership; enable email
  verification if that matters.
- The Codex adapter is experimental and disabled by default.
- Authenticated website research is intentionally out of scope for the first release.
