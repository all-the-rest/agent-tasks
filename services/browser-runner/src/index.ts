import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { BrowserPool } from './browser.js';

const token = process.env.RUNNER_TOKEN;
if (!token || token.length < 16) {
  console.error(JSON.stringify({ level: 'error', event: 'startup', message: 'RUNNER_TOKEN must be set (>=16 chars)' }));
  process.exit(1);
}

const allowedPorts = (process.env.RUNNER_ALLOWED_PORTS ?? '80,443')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
const allowHttp = process.env.RUNNER_ALLOW_HTTP !== 'false';
const chromiumSandbox = process.env.RUNNER_CHROMIUM_SANDBOX !== 'false';
if (!chromiumSandbox) {
  console.warn(JSON.stringify({ level: 'warn', event: 'sandbox_disabled', message: 'Chromium sandbox disabled; do not use this in production' }));
}

const pool = new BrowserPool(
  {
    maxSessions: Number(process.env.RUNNER_MAX_SESSIONS ?? '2'),
    sessionTtlMs: Number(process.env.RUNNER_SESSION_TTL_MS ?? '120000'),
    actionTimeoutMs: Number(process.env.RUNNER_ACTION_TIMEOUT_MS ?? '30000'),
    maxTextChars: Number(process.env.RUNNER_MAX_TEXT_CHARS ?? '30000'),
  },
  { allowedPorts, allowHttp, chromiumSandbox },
);

// The runner has no database, no admin credentials and no user secrets: only the
// token the worker presents, plus the browsing policy in the environment.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 256 * 1024, trustProxy: false });

const expected = Buffer.from(token);

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/healthz') return;
  const provided = request.headers['x-runner-token'];
  if (typeof provided !== 'string' || provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), expected)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/healthz', async () => ({ ok: true, sessions: pool.sessionCount }));

app.get('/v1/blocked', async () => ({ blocked: pool.blockedRequests.slice(-50) }));

app.post('/v1/sessions', async (_request, reply) => {
  try {
    const sessionId = await pool.create();
    return { sessionId };
  } catch (error) {
    return reply.code(503).send({ error: (error as Error).message });
  }
});

app.post<{ Params: { id: string }; Body: unknown }>('/v1/sessions/:id/actions', async (request, reply) => {
  const result = await pool.act(request.params.id, request.body);
  return reply.code(result.ok ? 200 : 200).send(result);
});

app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (request) => {
  await pool.destroy(request.params.id);
  return { ok: true };
});

async function shutdown(): Promise<void> {
  await app.close();
  await pool.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await pool.start();
  const port = Number(process.env.PORT ?? '8081');
  await app.listen({ host: '0.0.0.0', port });
  app.log.info({ event: 'runner_started', port, allowedPorts, allowHttp, chromiumSandbox });
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: (error as Error).message }));
  process.exit(1);
}
