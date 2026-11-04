# Authentication, roles and account lifecycle

_Labels: security_

## Goal

Secure authentication with exactly two roles, no default credentials, and invite-only onboarding by default.

## Acceptance criteria

- [x] Better Auth with email/password, minimum password length 12
- [x] Public registration disabled by default; onboarding through single-use invitations (7 days), with public registration available as an administrator-controlled option
- [x] Public sign-ups verify the e-mail address before sign-in; setup, environment bootstrap and invited accounts are provisioned verified
- [x] First-admin bootstrap with a deployment-provided `SETUP_TOKEN`, refused once an admin exists
- [x] Session revocation: sign-out is effective on the next request (no cookie session cache)
- [x] TOTP MFA with backup codes, verified before activation
- [x] Rate limits on sign-in, TOTP verification, password reset and sign-up
- [x] Password reset and email verification through a real SMTP transport (log transport in development)
- [x] Admin-only user management: role change, deactivation, last-admin guard
- [x] Audit log for every sensitive administrative operation
- [x] CSRF: Better Auth origin checks plus an explicit origin guard on app routes

## Evidence

- `test/integration/auth.test.ts`: setup token, single admin, logout, indistinguishable
  401s, default invite-only sign-up, registration toggle, public verification link,
  invite reuse, CSRF, real TOTP flow, 429.
- `test/integration/bootstrap.test.ts`: settings and admin bootstrap, open sign-up
  verified before the first session, invite-only default.
- `apps/api/src/auth.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/setup.ts`.
