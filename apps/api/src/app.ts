import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { AppError, toPublicError } from '@agent-tasks/shared';
import { user } from '@agent-tasks/database';
import type { AppContext } from './context.js';
import { requestSerializer } from './lib/log-redaction.js';
import { claimInvitation, registerSetupRoutes, releaseInvitation } from './routes/setup.js';
import type { ClaimedInvitation } from './routes/setup.js';
import { registerMeRoutes, registerAdminRoutes } from './routes/admin.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerTaskRoutes } from './routes/tasks.js';

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: context.env.LOG_LEVEL,
      // Fastify's default req serializer logs req.url; ours masks invitation tokens.
      serializers: { req: requestSerializer },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-runner-token"]',
          'req.headers["x-invite-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 512 * 1024,
    trustProxy: context.env.TRUST_PROXY === 'true',
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
  });

  /**
   * CSRF for our own routes: Better Auth checks Origin on /api/auth/*, the app
   * routes need the same guard because the session travels in a cookie. SameSite=Lax
   * is the second layer, this is the first.
   */
  const trustedOrigins = new Set([context.env.PUBLIC_BASE_URL.replace(/\/$/, ''), 'http://localhost:5173', 'http://localhost:8080']);
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/auth')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !trustedOrigins.has(origin)) throw AppError.forbidden('request origin is not allowed');
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const publicError = toPublicError(error);
    if (publicError.code === 'internal') {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(error.statusCode ?? 500).send({ error: { code: 'internal', message: 'internal server error' } });
    }
    return reply.code(error.statusCode ?? 400).send({ error: publicError });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });

  /**
   * Better Auth talks the Fetch API; this bridge mounts it under /api/auth and adds
   * the one policy Better Auth does not know: public registration is closed, so
   * POST /api/auth/sign-up/email is only forwarded after the invite token has been
   * atomically claimed for exactly that address. The claim is released again if
   * Better Auth refuses the sign-up, and the invite role is applied on success —
   * the same contract as /api/invitations/accept.
   */
  const authHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(request.url, context.env.PUBLIC_BASE_URL);
    const isSignUp = url.pathname.endsWith('/sign-up/email');
    let claimed: ClaimedInvitation | null = null;
    if (isSignUp) {
      const token = request.headers['x-invite-token'];
      const email = (request.body as { email?: string } | undefined)?.email;
      if (typeof token !== 'string' || !email) throw AppError.forbidden('registration requires an invitation');
      const invite = await claimInvitation(context.db, token);
      if (!invite || invite.email.toLowerCase() !== email.toLowerCase()) {
        if (invite) await releaseInvitation(context.db, invite.id);
        throw AppError.forbidden('invalid invitation');
      }
      claimed = invite;
    }

    const headers = fromNodeHeaders(request.headers);
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }
    const webRequest = new Request(url, { method: request.method, headers, body });
    let response: Response;
    try {
      response = await context.auth.handler(webRequest);
    } catch (error) {
      if (claimed) await releaseInvitation(context.db, claimed.id);
      throw error;
    }
    if (claimed) {
      if (response.status < 400) {
        await context.db
          .update(user)
          .set({ role: claimed.role, emailVerified: true })
          .where(eq(user.email, claimed.email.toLowerCase()));
      } else {
        await releaseInvitation(context.db, claimed.id);
      }
    }

    reply.code(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'set-cookie') continue;
      reply.header(key, value);
    }
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) reply.header('set-cookie', cookies);
    const buffer = Buffer.from(await response.arrayBuffer());
    return reply.send(buffer.length > 0 ? buffer : null);
  };

  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/auth/*', handler: authHandler });

  await registerSetupRoutes(app, context);
  await registerMeRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerTaskRoutes(app, context);
  await registerAdminRoutes(app, context);

  app.addHook('onClose', async () => {
    const { closeBoss } = await import('./lib/queue.js');
    await closeBoss();
  });

  return app;
}
