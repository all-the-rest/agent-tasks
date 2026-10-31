# Authentication, roles and account lifecycle

_Labels: security_

## Goal

Secure, invite-only authentication with exactly two roles and no default credentials.

## Acceptance criteria

- [x] Better Auth with email/password, minimum password length 12
- [x] Public registration disabled; onboarding only through single-use invitations (7 days)
- [x] First-admin bootstrap with a deployment-provided `SETUP_TOKEN`, refused once an admin exists
- [x] Session revocation: sign-out is effective on the next request (no cookie session cache)
- [x] TOTP MFA with backup codes, verified before activation
- [x] Rate limits on sign-in, TOTP verification, password reset and sign-up
- [x] Password reset and email verification through a real SMTP transport (log transport in development)
- [x] Admin-only user management: role change, deactivation, last-admin guard
- [x] Audit log for every sensitive administrative operation
- [x] CSRF: Better Auth origin checks plus an explicit origin guard on app routes

## Evidence

- `test/integration/auth.test.ts` (10 tests): setup token, single admin, logout, indistinguishable
  401s, blocked direct sign-up, invite reuse, CSRF, real TOTP flow, 429.
- `apps/api/src/auth.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/setup.ts`.
