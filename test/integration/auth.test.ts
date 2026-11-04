import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createHarness, createCapturingMailer, bootstrapAdmin, inviteAndAccept } from '../helpers/harness';
import { secretFromTotpUri, totp } from '../helpers/totp';
import type { CapturingMailer, TestHarness } from '../helpers/harness';
import { ensureBootstrap } from '../../apps/api/src/bootstrap';

let harness: TestHarness;
let capturingMailer: CapturingMailer;

beforeAll(async () => {
  capturingMailer = createCapturingMailer();
  harness = await createHarness({}, capturingMailer);
});

afterAll(async () => {
  await harness.close();
});

describe('authentication', () => {
  it('reports an unconfigured instance and refuses setup with a wrong token', async () => {
    const status = await harness.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toEqual({ configured: false });

    const rejected = await harness.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'wrong-token', email: 'a@example.com', password: 'admin-password-123', name: 'A' },
    });
    expect(rejected.statusCode).toBe(403);
  });

  it('creates exactly one admin from the setup token and refuses a second setup', async () => {
    const verificationCount = capturingMailer.messages.filter((message) => message.subject.includes('Verify')).length;
    const setup = await harness.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: harness.env.SETUP_TOKEN, email: 'admin@example.com', password: 'admin-password-123', name: 'Admin' },
    });
    expect(setup.statusCode).toBe(200);
    expect(capturingMailer.messages.filter((message) => message.subject.includes('Verify'))).toHaveLength(verificationCount);

    const again = await harness.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: harness.env.SETUP_TOKEN, email: 'second@example.com', password: 'admin-password-123', name: 'Second' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires a session for protected endpoints', async () => {
    const unauthenticated = await harness.app.inject({ method: 'GET', url: '/api/me' });
    expect(unauthenticated.statusCode).toBe(401);
    const tasks = await harness.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(tasks.statusCode).toBe(401);
  });

  it('logs in, returns the session, and logs out again', async () => {
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookiesFrom(login);
    expect(cookie).toContain('=');

    const me = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('ADMIN');

    const signOut = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie }, payload: {} });
    expect(signOut.statusCode).toBe(200);

    const after = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a wrong password without leaking whether the account exists', async () => {
    const wrong = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'nope-nope-nope' } });
    const unknown = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'ghost@example.com', password: 'nope-nope-nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().message).toBe(unknown.json().message);
  });

  it('closes public registration: sign-up without a valid invite is refused', async () => {
    const direct = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'sneaky@example.com', password: 'sneaky-password-123', name: 'Sneaky' },
    });
    expect(direct.statusCode).toBe(403);

    const forged = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'x-invite-token': 'not-a-real-token' },
      payload: { email: 'sneaky@example.com', password: 'sneaky-password-123', name: 'Sneaky' },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('honours the admin registration setting without granting an admin role', async () => {
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'admin-password-123' } });
    const cookie = cookiesFrom(login);
    const settings = await harness.app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    const update = (allowRegistration: boolean) => harness.app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie },
      payload: { ...settings.json(), allowRegistration },
    });
    expect((await update(true)).statusCode).toBe(200);
    try {
      const signup = await harness.app.inject({
        method: 'POST', url: '/api/auth/sign-up/email',
        payload: { email: 'public@example.com', password: 'public-password-123', name: 'Public' },
      });
      expect(signup.statusCode, signup.body).toBe(200);
      const users = await harness.db.pool.query<{ role: string }>('select role from "user" where email = $1', ['public@example.com']);
      expect(users.rows[0]?.role).toBe('USER');
    } finally {
      expect((await update(false)).statusCode).toBe(200);
    }
    const blocked = await harness.app.inject({
      method: 'POST', url: '/api/auth/sign-up/email',
      payload: { email: 'blocked@example.com', password: 'blocked-password-123', name: 'Blocked' },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('sends verification mail for public sign-up but not for trusted onboarding', async () => {
    const verificationCount = () => capturingMailer.messages.filter((message) => message.subject.includes('Verify')).length;
    const initialCount = verificationCount();
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    const cookie = cookiesFrom(login);
    const invitation = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie },
      payload: { email: 'mail-bridge@example.com', role: 'USER' },
    });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const invitedSignup = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'x-invite-token': invitation.json().token },
      payload: { email: 'mail-bridge@example.com', password: 'invite-password-123', name: 'Invited' },
    });
    expect(invitedSignup.statusCode, invitedSignup.body).toBe(200);
    expect(verificationCount()).toBe(initialCount);

    const acceptedInvitation = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie },
      payload: { email: 'mail-accept@example.com', role: 'USER' },
    });
    expect(acceptedInvitation.statusCode, acceptedInvitation.body).toBe(201);
    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      payload: { token: acceptedInvitation.json().token, name: 'Invited', password: 'invite-password-123' },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(verificationCount()).toBe(initialCount);

    const settings = await harness.app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } });
    const opened = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie },
      payload: { ...settings.json(), allowRegistration: true },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    try {
      const publicSignup = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'x-agent-tasks-trusted-signup': 'true' },
        payload: { email: 'mail-public@example.com', password: 'public-password-123', name: 'Public' },
      });
      expect(publicSignup.statusCode, publicSignup.body).toBe(200);
      expect(verificationCount()).toBe(initialCount + 1);
    } finally {
      await harness.app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { cookie },
        payload: { ...settings.json(), allowRegistration: false },
      });
    }
  });

  it('onboards invited users and rejects an invite reused for another address', async () => {
    const adminCookie = cookiesFrom(
      await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'admin-password-123' } }),
    );
    const invite = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie: adminCookie },
      payload: { email: 'alice@example.com', role: 'USER' },
    });
    expect(invite.statusCode).toBe(201);
    const token = invite.json().token as string;

    const preview = await harness.app.inject({ method: 'GET', url: `/api/invitations/${token}` });
    expect(preview.json().email).toBe('alice@example.com');

    const wrongAddress = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'x-invite-token': token },
      payload: { email: 'mallory@example.com', password: 'mallory-password-123', name: 'Mallory' },
    });
    expect(wrongAddress.statusCode).toBe(403);

    const accept = await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      payload: { token, name: 'Alice', password: 'alice-password-123' },
    });
    expect(accept.statusCode).toBe(200);

    const reuse = await harness.app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      payload: { token, name: 'Alice Again', password: 'alice-password-123' },
    });
    expect(reuse.statusCode).toBe(404);
  });

  it('rejects cross-origin POSTs (CSRF)', async () => {
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'admin-password-123' } });
    const cookie = cookiesFrom(login);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie, origin: 'https://evil.example' },
      payload: {},
    });
    expect([403, 401]).toContain(response.statusCode);
  });

  it('enables TOTP for the admin and requires it at sign-in', async () => {
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'admin-password-123' } });
    const cookie = cookiesFrom(login);
    const enable = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/enable',
      headers: { cookie },
      payload: { password: 'admin-password-123' },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const secret = secretFromTotpUri(enable.json().totpURI as string);

    // The pending secret only becomes active after a valid code (no skipVerification).
    const confirm = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { cookie },
      payload: { code: totp(secret) },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);

    const signIn = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'admin-password-123' } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    expect(signIn.json().twoFactorRedirect).toBe(true);

    const wrongCode = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      payload: { code: '000000' },
      headers: { cookie: cookiesFrom(signIn) },
    });
    expect([400, 401, 403]).toContain(wrongCode.statusCode);

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      payload: { code: totp(secret) },
      headers: { cookie: cookiesFrom(signIn) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const sessionCookie = cookiesFrom(verified) || cookiesFrom(signIn);
    const me = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sessionCookie } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user.id).toBeTruthy();
  });

  it('rate-limits repeated failed sign-ins', async () => {
    // A dedicated instance with the production default (5 per minute) so the
    // assertion exercises the real boundary instead of a test-only value.
    const isolated = await createHarness({ RATE_LIMIT_SIGNIN_MAX: 5 });
    try {
      await bootstrapAdmin(isolated);
      const attempts = [];
      for (let index = 0; index < 8; index += 1) {
        attempts.push(await isolated.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'admin@example.com', password: 'wrong-password-123' } }));
      }
      expect(attempts.filter((response) => response.statusCode === 429).length).toBeGreaterThan(0);
      expect(attempts.find((response) => response.statusCode === 429)?.statusCode).toBe(429);
    } finally {
      await isolated.close();
    }
  });

  it('requires e-mail verification for public registration and sends the verification link', async () => {
    const mailer = createCapturingMailer();
    const isolated = await createHarness({ ALLOW_REGISTRATION: 'true' }, mailer);
    try {
      await ensureBootstrap(isolated.context);
      const signup = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: { email: 'verify@example.com', password: 'verify-password-123', name: 'Verify' },
      });
      expect(signup.statusCode, signup.body).toBe(200);
      // requireEmailVerification makes sign-up non-authenticating: no token, no cookie.
      expect(signup.json().token).toBeNull();
      expect(cookiesFrom(signup)).toBe('');
      expect(mailer.messages).toHaveLength(1);
      expect(mailer.messages[0]).toMatchObject({ to: 'verify@example.com', subject: 'Verify your Agent Tasks address' });
      const verificationUrl = mailer.messages[0]?.text.match(/https?:\/\/[^\s)]+/)?.[0];
      expect(verificationUrl).toBeTruthy();

      const userBeforeVerification = await isolated.db.pool.query<{ email_verified: boolean }>(
        'select email_verified from "user" where email = $1',
        ['verify@example.com'],
      );
      expect(userBeforeVerification.rows[0]?.email_verified).toBe(false);
      const unverifiedSignIn = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'verify@example.com', password: 'verify-password-123' },
      });
      expect(unverifiedSignIn.statusCode, unverifiedSignIn.body).toBe(403);
      expect(unverifiedSignIn.json().code).toBe('EMAIL_NOT_VERIFIED');
      expect(cookiesFrom(unverifiedSignIn)).toBe('');

      const link = new URL(verificationUrl as string);
      const verify = await isolated.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
      expect([200, 302, 303]).toContain(verify.statusCode);
      const userAfterVerification = await isolated.db.pool.query<{ email_verified: boolean }>(
        'select email_verified from "user" where email = $1',
        ['verify@example.com'],
      );
      expect(userAfterVerification.rows[0]?.email_verified).toBe(true);
      const verifiedSignIn = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'verify@example.com', password: 'verify-password-123' },
      });
      expect(verifiedSignIn.statusCode, verifiedSignIn.body).toBe(200);
    } finally {
      await isolated.close();
    }
  });

  it('re-issues a verification link without revealing whether the address has an account', async () => {
    const mailer = createCapturingMailer();
    const isolated = await createHarness({ ALLOW_REGISTRATION: 'true' }, mailer);
    try {
      await ensureBootstrap(isolated.context);
      const signup = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: { email: 'resend@example.com', password: 'resend-password-123', name: 'Resend' },
      });
      expect(signup.statusCode, signup.body).toBe(200);
      expect(mailer.messages).toHaveLength(1);

      const resent = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/send-verification-email',
        payload: { email: 'resend@example.com' },
      });
      expect(resent.statusCode, resent.body).toBe(200);
      expect(resent.json()).toEqual({ status: true });
      expect(mailer.messages).toHaveLength(2);
      expect(mailer.messages[1]).toMatchObject({
        to: 'resend@example.com',
        subject: 'Verify your Agent Tasks address',
      });
      expect(mailer.messages[1]?.text).toMatch(/verify-email\?token=/);

      // Unknown addresses receive the same body and no mail. Together with the
      // constant-time floor in Better Auth this avoids an enumeration oracle.
      const unknown = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/send-verification-email',
        payload: { email: 'ghost@example.com' },
      });
      expect(unknown.statusCode, unknown.body).toBe(200);
      expect(unknown.json()).toEqual(resent.json());
      expect(mailer.messages).toHaveLength(2);
    } finally {
      await isolated.close();
    }
  });

  it('rate-limits repeated verification link requests', async () => {
    const isolated = await createHarness({ ALLOW_REGISTRATION: 'true' });
    try {
      await ensureBootstrap(isolated.context);
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await isolated.app.inject({
          method: 'POST',
          url: '/api/auth/send-verification-email',
          payload: { email: `ghost-${index}@example.com` },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
    } finally {
      await isolated.close();
    }
  });
});

/**
 * Regression tests for the audit's C1, H1 and H2. Each case owns a fresh harness
 * (the helper truncates the shared database) so no test depends on another's state.
 */
describe('security regressions', () => {
  it('rejects a session that carries an impersonation marker', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const alice = await inviteAndAccept(isolated, admin.cookie, 'alice@example.com');
      expect(alice.cookie).toContain('=');

      // The admin plugin is gone, so auth.api.impersonateUser does not exist any
      // more. Marking a *real* Better Auth session row the way the plugin did is
      // the honest stand-in: the victim's cookie + session row, flagged as
      // impersonated, must not resolve to an app identity.
      const adminRow = await isolated.db.pool.query<{ id: string }>('select id from "user" where email = $1', ['admin@example.com']);
      const adminId = adminRow.rows[0]?.id;
      expect(adminId).toBeTruthy();
      const marked = await isolated.db.pool.query(
        'update "session" set impersonated_by = $1 where user_id = (select id from "user" where email = $2)',
        [adminId, 'alice@example.com'],
      );
      expect(marked.rowCount ?? 0).toBeGreaterThan(0);

      const me = await isolated.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } });
      expect(me.statusCode, me.body).toBe(401);
      const tasks = await isolated.app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: alice.cookie } });
      expect(tasks.statusCode, tasks.body).toBe(401);

      // The administrator's own session is untouched.
      const adminMe = await isolated.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin.cookie } });
      expect(adminMe.statusCode, adminMe.body).toBe(200);
    } finally {
      await isolated.close();
    }
  });

  it('no longer routes the Better Auth admin plugin endpoints but keeps two-factor mounted', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const requests: Array<[string, Record<string, unknown>]> = [
        ['/api/auth/admin/set-role', { userId: admin.id, role: 'ADMIN' }],
        ['/api/auth/admin/impersonate-user', { userId: admin.id }],
        ['/api/auth/admin/ban-user', { userId: admin.id }],
        ['/api/auth/admin/create-user', { email: 'bypass@example.com', password: 'bypass-password-123', name: 'Bypass' }],
      ];
      for (const [url, payload] of requests) {
        const response = await isolated.app.inject({ method: 'POST', url, headers: { cookie: admin.cookie }, payload });
        expect(response.statusCode, `${url}: ${response.body}`).not.toBe(200);
        expect([401, 403, 404], `${url} answered ${response.statusCode}`).toContain(response.statusCode);
      }

      // The two-factor plugin must still be mounted (it is the one plugin we keep).
      const twoFactor = await isolated.app.inject({ method: 'POST', url: '/api/auth/two-factor/enable', payload: { password: 'admin-password-123' } });
      expect(twoFactor.statusCode, twoFactor.body).not.toBe(404);
      expect([400, 401]).toContain(twoFactor.statusCode);
    } finally {
      await isolated.close();
    }
  });

  it('accepts one invitation exactly once under concurrent requests', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const invite = await isolated.app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { cookie: admin.cookie },
        payload: { email: 'race@example.com', role: 'USER' },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const token = invite.json().token as string;

      const accept = () =>
        isolated.app.inject({
          method: 'POST',
          url: '/api/invitations/accept',
          payload: { token, name: 'Race User', password: 'race-password-123' },
        });
      const responses = await Promise.all([accept(), accept()]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 404]);

      const users = await isolated.db.pool.query<{ count: number }>('select count(*)::int as count from "user" where email = $1', ['race@example.com']);
      expect(users.rows[0]?.count).toBe(1);
    } finally {
      await isolated.close();
    }
  });

  it('rejects expired invitation previews and acceptance', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const invite = await isolated.app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { cookie: admin.cookie },
        payload: { email: 'expired@example.com', role: 'USER' },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const token = invite.json().token as string;
      await isolated.db.pool.query("update invitations set expires_at = now() - interval '1 second' where email = $1", ['expired@example.com']);

      const preview = await isolated.app.inject({ method: 'GET', url: `/api/invitations/${token}` });
      const accept = await isolated.app.inject({
        method: 'POST',
        url: '/api/invitations/accept',
        payload: { token, name: 'Expired User', password: 'expired-password-123' },
      });
      expect(preview.statusCode).toBe(404);
      expect(accept.statusCode).toBe(404);
      const users = await isolated.db.pool.query<{ count: number }>('select count(*)::int as count from "user" where email = $1', ['expired@example.com']);
      expect(users.rows[0]?.count).toBe(0);
    } finally {
      await isolated.close();
    }
  });

  it('consumes the invitation when sign-up goes through the auth bridge', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const invite = await isolated.app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { cookie: admin.cookie },
        payload: { email: 'bridge@example.com', role: 'USER' },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const token = invite.json().token as string;

      const signUp = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { 'x-invite-token': token },
        payload: { email: 'bridge@example.com', password: 'bridge-password-123', name: 'Bridge' },
      });
      expect([200, 201], signUp.body).toContain(signUp.statusCode);

      const stored = await isolated.db.pool.query<{ accepted_at: Date | null; email_verified: boolean }>(
        'select invitations.accepted_at, "user".email_verified from invitations join "user" on "user".email = invitations.email where invitations.email = $1',
        ['bridge@example.com'],
      );
      expect(stored.rows[0]?.accepted_at).not.toBeNull();
      expect(stored.rows[0]?.email_verified).toBe(true);
      const inviteLogin = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'bridge@example.com', password: 'bridge-password-123' },
      });
      expect(inviteLogin.statusCode, inviteLogin.body).toBe(200);

      const reuse = await isolated.app.inject({
        method: 'POST',
        url: '/api/invitations/accept',
        payload: { token, name: 'Bridge Again', password: 'bridge-password-123' },
      });
      expect(reuse.statusCode).toBe(404);
    } finally {
      await isolated.close();
    }
  });

  it('rejects an expired invitation and a banned user session', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const created = await isolated.app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { cookie: admin.cookie },
        payload: { email: 'expired@example.com', role: 'USER' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const token = (created.json() as { token: string }).token;
      await isolated.db.pool.query(`update invitations set expires_at = now() - interval '1 hour'`);
      const expired = await isolated.app.inject({
        method: 'POST',
        url: '/api/invitations/accept',
        payload: { token, name: 'Expired User', password: 'expired-password-123' },
      });
      expect(expired.statusCode).toBe(404);

      const member = await inviteAndAccept(isolated, admin.cookie, 'banned@example.com');
      expect((await isolated.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: member.cookie } })).statusCode).toBe(200);
      await isolated.db.pool.query(`update "user" set banned = true where email = 'banned@example.com'`);
      expect((await isolated.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: member.cookie } })).statusCode).toBe(401);
      const signIn = await isolated.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'banned@example.com', password: 'user-password-123' },
      });
      expect(signIn.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await isolated.close();
    }
  });

  it('returns the role in the Better Auth session so the admin UI gate works', async () => {
    const isolated = await createHarness();
    try {
      const admin = await bootstrapAdmin(isolated);
      const session = await isolated.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie: admin.cookie },
      });
      expect(session.statusCode).toBe(200);
      const payload = session.json() as { user?: { role?: string } };
      expect(payload.user?.role).toBe('ADMIN');

      const member = await inviteAndAccept(isolated, admin.cookie, 'role-check@example.com');
      const memberSession = await isolated.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie: member.cookie },
      });
      expect((memberSession.json() as { user?: { role?: string } }).user?.role).toBe('USER');
    } finally {
      await isolated.close();
    }
  });

  it('creates exactly one admin when setup is submitted twice concurrently', async () => {
    const isolated = await createHarness();
    try {
      const submit = (email: string) =>
        isolated.app.inject({
          method: 'POST',
          url: '/api/setup',
          payload: { token: isolated.env.SETUP_TOKEN, email, password: 'admin-password-123', name: 'Admin' },
        });
      // Different addresses, so a unique-email violation cannot be what serialises them.
      const responses = await Promise.all([submit('first@example.com'), submit('second@example.com')]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

      const users = await isolated.db.pool.query<{ count: number }>('select count(*)::int as count from "user"');
      expect(users.rows[0]?.count).toBe(1);
    } finally {
      await isolated.close();
    }
  });
});
