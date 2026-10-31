import { randomBytes } from 'node:crypto';
import { createDatabase, runMigrations } from '@agent-tasks/database';
import { createAuth } from './auth.js';
import { buildApp } from './app.js';
import { createContext } from './context.js';
import { loadEnv } from './env.js';
import { createMailer } from './mailer.js';

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);

if (process.env.RUN_MIGRATIONS === 'true') {
  await runMigrations(env.DATABASE_URL);
}

const setupToken = env.SETUP_TOKEN ?? randomBytes(24).toString('base64url');
const mailer = createMailer({ smtpUrl: env.SMTP_URL, from: env.SMTP_FROM, nodeEnv: env.NODE_ENV });
const auth = createAuth({ db: database.db, env, mailer });
const context = createContext({ db: database.db, env, auth, mailer });

const app = await buildApp(context);

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
