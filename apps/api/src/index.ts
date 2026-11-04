import { randomBytes } from 'node:crypto';
import { createDatabase, runMigrations } from '@agent-tasks/database';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { ensureBootstrap } from './bootstrap.js';
import { createContext } from './context.js';
import { loadEnv } from './env.js';
import { createMailer } from './mailer.js';

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);

if (env.NODE_ENV === 'production' && !env.SETUP_TOKEN && !(env.ADMIN_EMAIL && env.ADMIN_PASSWORD)) {
  throw new Error(
    'production requires ADMIN_EMAIL/ADMIN_PASSWORD (first-admin bootstrap) or SETUP_TOKEN',
  );
}

if (process.env.RUN_MIGRATIONS === 'true') {
  await runMigrations(env.DATABASE_URL);
}

const setupToken = env.SETUP_TOKEN ?? randomBytes(24).toString('base64url');
const mailer = createMailer({ smtpUrl: env.SMTP_URL, from: env.SMTP_FROM, nodeEnv: env.NODE_ENV });
const auth = createAuth({ db: database.db, env, mailer });
const context = createContext({ db: database.db, env, auth, mailer });

const app = await buildApp(context);

// Materialise settings/admin/provider seeds before accepting requests. The wait
// covers a fresh deployment where the worker has not finished migrating yet.
const bootstrap = await ensureBootstrap(context);
const settings = await context.settings();
if (env.NODE_ENV === 'production' && settings.allowRegistration && mailer.kind !== 'smtp') {
  throw new Error('production open registration requires SMTP_URL so users can verify their e-mail addresses');
}
app.log.info({ event: 'bootstrap', ...bootstrap }, 'database bootstrap complete');

app.log.info(
  {
    event: 'startup',
    mailer: mailer.kind,
    setupTokenConfigured: Boolean(env.SETUP_TOKEN),
  },
  'agent-tasks api starting',
);

if (env.NODE_ENV !== 'production' && !env.SETUP_TOKEN) {
  // Development convenience only: the token is printed once so a local operator can
  // bootstrap the first admin. Production must set SETUP_TOKEN explicitly.
  console.info(JSON.stringify({ level: 'info', event: 'setup_token', token: setupToken }));
}

const close = async (signal: string): Promise<void> => {
  app.log.info({ event: 'shutdown', signal });
  await app.close();
  await database.close();
  process.exit(0);
};

process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
