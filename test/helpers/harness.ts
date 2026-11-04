import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createDatabase } from '@agent-tasks/database';
import type { DatabaseHandle } from '@agent-tasks/database';
import { createAuth } from '../../apps/api/src/auth';
import { buildApp } from '../../apps/api/src/app';
import { createContext } from '../../apps/api/src/context';
import type { AppContext } from '../../apps/api/src/context';
import { createMailer } from '../../apps/api/src/mailer';
import type { Mailer } from '../../apps/api/src/mailer';
import type { ApiEnv } from '../../apps/api/src/env';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://agent:agent@dind:55432/agent_tasks';

export interface CapturingMailer extends Mailer {
  readonly messages: Array<{ to: string; subject: string; text: string; html?: string }>;
}

/** Keeps transactional mail in memory so tests can follow the real link. */
export function createCapturingMailer(): CapturingMailer {
  const messages: CapturingMailer['messages'] = [];
  return {
    kind: 'log',
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

export interface TestHarness {
  app: FastifyInstance;
  db: DatabaseHandle;
  context: AppContext;
  env: ApiEnv;
  close(): Promise<void>;
}

export function testEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    PUBLIC_BASE_URL: 'http://localhost:5173',
    AUTH_SECRET: randomBytes(32).toString('hex'),
    SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SETUP_TOKEN: 'setup-token-for-tests-1234',
    ADMIN_EMAIL: undefined,
    ADMIN_PASSWORD: undefined,
    ADMIN_NAME: 'Administrator',
    ALLOW_REGISTRATION: 'false',
    LOG_LEVEL: 'error',
    TRUST_PROXY: 'false',
    COOKIE_SECURE: 'false',
    RATE_LIMIT_SIGNIN_MAX: 100,
    RATE_LIMIT_SESSION_MAX: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    ...overrides,
  } as ApiEnv;
}

export async function resetDatabase(db: DatabaseHandle): Promise<void> {
  await db.pool.query(
    'truncate table audit_logs, recommendation_events, recommendations, memory_changes, memory_suggestions, memory_tombstones, memory_revisions, memories, execution_sources, execution_steps, executions, tasks, provider_models, provider_credentials, providers, invitations, user_preferences, system_settings, two_factor, session, account, verification, rate_limit, "user" cascade',
  );
}

export async function createHarness(overrides: Partial<ApiEnv> = {}, testMailer?: Mailer): Promise<TestHarness> {
  const env = testEnv(overrides);
  const db = createDatabase(env.DATABASE_URL, { max: 4 });
  await resetDatabase(db);
  const mailer = testMailer ?? createMailer({ nodeEnv: 'test' });
  const auth = createAuth({ db: db.db, env, mailer });
  const context = createContext({ db: db.db, env, auth, mailer });
  const app = await buildApp(context);
  return {
    app,
    db,
    context,
    env,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export function cookiesFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  return list
    .map((cookie) => cookie.split(';')[0])
    .filter((cookie): cookie is string => Boolean(cookie))
    .join('; ');
}

export async function bootstrapAdmin(harness: TestHarness, email = 'admin@example.com', password = 'admin-password-123'): Promise<{ cookie: string; id: string }> {
  const setup = await harness.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: harness.env.SETUP_TOKEN, email, password, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode} ${setup.body}`);
  const login = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return { cookie: cookiesFrom(login), id: login.json().user?.id };
}

export async function inviteAndAccept(
  harness: TestHarness,
  adminCookie: string,
  email: string,
  password = 'user-password-123',
): Promise<{ cookie: string; id: string }> {
  const invite = await harness.app.inject({ method: 'POST', url: '/api/admin/invitations', headers: { cookie: adminCookie }, payload: { email, role: 'USER' } });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.statusCode} ${invite.body}`);
  const token = invite.json().token as string;
  const accept = await harness.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, name: email.split('@')[0], password } });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);
  const login = await harness.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return { cookie: cookiesFrom(login), id: login.json().user?.id };
}
