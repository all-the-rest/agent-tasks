import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Database } from '@agent-tasks/database';
import * as schema from '@agent-tasks/database';
import type { ApiEnv } from './env.js';
import { renderActionEmail } from './lib/email-templates.js';
import type { Mailer } from './mailer.js';

/** Internal-only marker for accounts whose e-mail is verified by trusted onboarding. */
export const TRUSTED_SIGNUP_HEADER = 'x-agent-tasks-trusted-signup';
const trustedSignupContext = new AsyncLocalStorage<boolean>();

/** Marks an internal Better Auth signup as trusted for the duration of its async call. */
export function withTrustedSignup<T>(signup: () => Promise<T>): Promise<T> {
  return trustedSignupContext.run(true, signup);
}

export interface AuthDeps {
  db: Database;
  env: ApiEnv;
  mailer: Mailer;
}

export function createAuth({ db, env, mailer }: AuthDeps) {
  return betterAuth({
    appName: 'Agent Tasks',
    baseURL: env.PUBLIC_BASE_URL,
    secret: env.AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
      usePlural: false,
    }),
    emailAndPassword: {
      enabled: true,
      // The HTTP bridge in app.ts enforces the registration setting and invite tokens.
      disableSignUp: false,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      requireEmailVerification: true,
      async sendResetPassword({ user, url }) {
        const content = renderActionEmail({
          heading: 'Reset your password',
          paragraphs: ['Use this single-use link to choose a new password. It expires shortly and can be used once.'],
          actionLabel: 'Choose a new password',
          actionUrl: url,
          footer: 'If you did not request this mail, you can ignore it.',
        });
        await mailer.send({ to: user.email, subject: 'Reset your Agent Tasks password', ...content });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }, request) {
        if (trustedSignupContext.getStore() || request?.headers.get(TRUSTED_SIGNUP_HEADER) === 'true') return;
        const content = renderActionEmail({
          heading: 'Verify your e-mail address',
          paragraphs: ['Confirm that this address belongs to your Agent Tasks account.'],
          actionLabel: 'Verify address',
          actionUrl: url,
        });
        await mailer.send({ to: user.email, subject: 'Verify your Agent Tasks address', ...content });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
      // No cookie cache: revocation and sign-out must be visible on the next request,
      // not after a cache window.
      cookieCache: { enabled: false },
    },
    /**
     * The admin plugin used to own this check. It is deliberately not installed
     * (its /api/auth/admin/* endpoints bypassed our last-admin guard, the audit
     * log and invite-only onboarding), so the one behaviour we still need is
     * reproduced here: a banned account cannot obtain a session.
     */
    databaseHooks: {
      session: {
        create: {
          before: async (newSession) => {
            const rows = await db
              .select({ banned: schema.user.banned })
              .from(schema.user)
              .where(eq(schema.user.id, newSession.userId))
              .limit(1);
            if (rows[0]?.banned) {
              throw APIError.from('FORBIDDEN', { message: 'account is disabled', code: 'BANNED_USER' });
            }
            return { data: newSession };
          },
        },
      },
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
      // The admin plugin is intentionally not mounted (it would expose endpoints that
      // bypass our audit and last-admin rules). `role` is still a DB column and must be
      // part of the session payload so the web UI's RequireAdmin gate can see it.
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'USER', input: false },
      },
    },
    trustedOrigins: [env.PUBLIC_BASE_URL, ...(env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://localhost:8080'])],
    advanced: {
      useSecureCookies: env.COOKIE_SECURE === 'true',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.COOKIE_SECURE === 'true',
        path: '/',
      },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      disableCSRFCheck: false,
    },
    rateLimit: {
      enabled: true,
      window: env.RATE_LIMIT_WINDOW_SECONDS,
      max: 60,
      storage: 'database',
      modelName: 'rateLimit',
      customRules: {
        '/sign-in/email': { window: env.RATE_LIMIT_WINDOW_SECONDS, max: env.RATE_LIMIT_SIGNIN_MAX },
        '/get-session': { window: env.RATE_LIMIT_WINDOW_SECONDS, max: env.RATE_LIMIT_SESSION_MAX },
        '/two-factor/verify-totp': { window: 60, max: 6 },
        '/request-password-reset': { window: 300, max: 3 },
        // Unauthenticated resends answer generically (and in constant time) for
        // unknown or already verified addresses; the same cap as a password
        // reset keeps the endpoint from becoming a mail-bomb amplifier.
        '/send-verification-email': { window: 300, max: 3 },
        '/sign-up/email': { window: 300, max: 5 },
      },
    },
    plugins: [
      twoFactor({ issuer: 'Agent Tasks', skipVerificationOnEnable: false }),
      /**
       * The admin() plugin is intentionally absent. Our own /api/admin routes own
       * role/banned management and enforce the last-admin guard, write an audit
       * entry and only onboard accounts through single-use invitations; mounting
       * Better Auth's admin endpoints would bypass all three. The schema columns
       * (user.role/banned, session.impersonated_by) stay, and lib/session.ts
       * rejects any session that carries an impersonation marker.
       */
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
