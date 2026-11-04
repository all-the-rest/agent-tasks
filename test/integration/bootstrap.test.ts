import { afterEach, describe, expect, it } from 'vitest';
import { providerCredentials, providers } from '@agent-tasks/database';
import { ensureBootstrap } from '../../apps/api/src/bootstrap';
import { bootstrapAdmin, cookiesFrom, createCapturingMailer, createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('first-start bootstrap', () => {
  it('creates the first admin and settings from env, idempotently, without seeding providers', async () => {
    harness = await createHarness({
      ADMIN_EMAIL: 'env-admin@example.com',
      ADMIN_PASSWORD: 'env-admin-password-123',
      ADMIN_NAME: 'Env Admin',
      ALLOW_REGISTRATION: 'true',
    });

    const first = await ensureBootstrap(harness.context);
    expect(first).toEqual({ settings: 'created', admin: 'created' });

    const config = await harness.app.inject({ method: 'GET', url: '/api/config' });
    expect(config.json().allowRegistration).toBe(true);
    expect(config.json().scheduleTimePresets).toEqual({
      morning: '09:00',
      afternoon: '14:00',
      evening: '18:00',
      night: '22:00',
    });

    const status = await harness.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toEqual({ configured: true });

    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'env-admin@example.com', password: 'env-admin-password-123' },
    });
    expect(login.statusCode).toBe(200);
    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookiesFrom(login) },
    });
    expect(me.json().user.role).toBe('ADMIN');

    // Deployment environment must never seed an inference provider; the admin
    // UI/API is the only write path for the shared connection.
    expect(await harness.context.db.select().from(providers)).toHaveLength(0);
    expect(await harness.context.db.select().from(providerCredentials)).toHaveLength(0);

    // A restart must not duplicate anything.
    const second = await ensureBootstrap(harness.context);
    expect(second).toEqual({ settings: 'exists', admin: 'exists' });
  });

  it('allows open sign-up only when the setting is enabled, after e-mail verification', async () => {
    const mailer = createCapturingMailer();
    harness = await createHarness({ ALLOW_REGISTRATION: 'true' }, mailer);
    await ensureBootstrap(harness.context);

    const signup = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'open@example.com', password: 'open-password-123', name: 'Open User' },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    expect(signup.json().token).toBeNull();
    expect(cookiesFrom(signup)).toBe('');
    expect(mailer.messages).toHaveLength(1);
    const verificationUrl = mailer.messages[0]?.text.match(/https?:\/\/[^\s)]+/)?.[0];
    expect(verificationUrl).toBeTruthy();

    // The new account exists, but no session is issued until the mailbox is proven.
    const beforeVerification = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'open@example.com', password: 'open-password-123' },
    });
    expect(beforeVerification.statusCode, beforeVerification.body).toBe(403);
    expect(beforeVerification.json().code).toBe('EMAIL_NOT_VERIFIED');

    const link = new URL(verificationUrl as string);
    const verify = await harness.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect([200, 302, 303]).toContain(verify.statusCode);

    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'open@example.com', password: 'open-password-123' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookiesFrom(login) },
    });
    expect(me.json().user.role).toBe('USER');
  });

  it('toggles open registration through the admin settings API', async () => {
    harness = await createHarness();
    const admin = await bootstrapAdmin(harness);

    const open = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { allowRegistration: true },
    });
    expect(open.statusCode).toBe(200);

    const allowed = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'toggle@example.com', password: 'toggle-password-123', name: 'Toggle' },
    });
    expect(allowed.statusCode).toBe(200);

    const closed = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: admin.cookie },
      payload: { allowRegistration: false },
    });
    expect(closed.statusCode).toBe(200);

    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'toggle2@example.com', password: 'toggle-password-123', name: 'Toggle 2' },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('keeps sign-up closed by default', async () => {
    harness = await createHarness();
    await ensureBootstrap(harness.context);

    const signup = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'closed@example.com', password: 'closed-password-123', name: 'Closed' },
    });
    expect(signup.statusCode).toBe(403);
  });
});
