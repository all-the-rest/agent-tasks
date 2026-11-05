import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import { AppError, toPublicError, WEB_CSP_DIRECTIVES } from '@agent-tasks/shared';
import type { AppContext } from './context.js';
import { TRUSTED_SIGNUP_HEADER } from './auth.js';
import { requestSerializer } from './lib/log-redaction.js';
import { claimInvitation, completeInvitationSignup, registerSetupRoutes, releaseInvitation } from './routes/setup.js';
import type { ClaimedInvitation, CreatedAccount } from './routes/setup.js';
import { registerMeRoutes, registerAdminRoutes } from './routes/admin.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerTaskShareRoutes } from './routes/task-shares.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { isSpaNavigation, registerWebApp, resolveWebRoot } from './static.js';
import { isUnlimitedHealthCheck, proxyTrust } from './http-policy.js';

/** Better Auth's sign-up payload; only the fields used for account binding. */
function createdAccount(buffer: Buffer): CreatedAccount {
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as { user?: { id?: unknown; email?: unknown } };
    return { id: payload.user?.id, email: payload.user?.email };
  } catch {
    return {};
  }
}

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
    // One proxy hop only: the documented Caddy/nginx deployment terminates TLS
    // once. Trusting every hop would accept a client-supplied X-Forwarded-For.
    trustProxy: proxyTrust(context.env.TRUST_PROXY),
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: WEB_CSP_DIRECTIVES,
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: context.env.RATE_LIMIT_API_MAX,
    timeWindow: '1 minute',
    // The container healthcheck must not consume the per-IP budget; every other
    // request, including the SPA, is limited. Only the in-container loopback
    // health probe bypasses the limiter, so a remote client cannot use the
    // database-backed health endpoint as an unlimited request amplifier.
    allowList: isUnlimitedHealthCheck,
  });

  /**
   * A share token is a bearer secret in the URL. Every response on a tokenized
   * path — the SPA shell, the public JSON read and each error branch — must stay
   * out of caches, out of Referer headers and out of search indexes. `no-store`
   * also keeps a revoked link from being served by an intermediary that cached
   * the successful response.
   */
  const isSharePath = (url: string): boolean => {
    const path = url.split('?')[0] ?? '';
    return path.startsWith('/share/') || path.startsWith('/api/shares/');
  };
  const protectShareReply = (reply: FastifyReply): void => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
  };

  /**
   * CSRF for our own routes: Better Auth checks Origin on /api/auth/*, the app
   * routes need the same guard because the session travels in a cookie. SameSite=Lax
   * is the second layer, this is the first.
   */
  const trustedOrigins = new Set([context.env.PUBLIC_BASE_URL.replace(/\/$/, ''), 'http://localhost:5173', 'http://localhost:8080']);
  app.addHook('onRequest', async (request, reply) => {
    if (isSharePath(request.url)) protectShareReply(reply);
    if (request.url.startsWith('/api/auth')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !trustedOrigins.has(origin)) throw AppError.forbidden('request origin is not allowed');
  });

  /**
   * The static handler sets `Referrer-Policy` and `Cache-Control` for index.html
   * after onRequest has run. It does not know the URL is a bearer link, so the
   * share policy must win after every handler, including the SPA fallback and the
   * error handler.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (isSharePath(request.url)) protectShareReply(reply);
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    // @fastify/static throws a plain 403 for non-canonical paths. Treat it as a
    // client error, not an internal failure, so a malformed URL neither logs a
    // stack trace nor breaks the documented error-code contract.
    if (error.statusCode === 403) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
    }
    // Rate-limit rejections are expected client errors, not internal failures;
    // logging them with a stack would be a log amplifier at the limit boundary.
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'too many requests' } });
    }
    const publicError = toPublicError(error);
    if (publicError.code === 'internal') {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(error.statusCode ?? 500).send({ error: { code: 'internal', message: 'internal server error' } });
    }
    return reply.code(error.statusCode ?? 400).send({ error: publicError });
  });

  const webRoot = resolveWebRoot(context.env.WEB_ROOT, context.env.NODE_ENV);
  app.setNotFoundHandler((request, reply) => {
    // The same URL can answer HTML or JSON depending on Accept; a shared cache
    // must not reuse one variant for the other.
    reply.header('Vary', 'Accept');
    if (webRoot && isSpaNavigation(request)) {
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });

  /**
   * Better Auth talks the Fetch API; this bridge mounts it under /api/auth and adds
   * the registration policy: with `allowRegistration` disabled (the default),
   * POST /api/auth/sign-up/email is only forwarded after the invite token has been
   * atomically claimed for exactly that address. With it enabled, a direct sign-up
   * creates a USER account; an invite token may still be supplied to choose a role.
   * The claim is released again if Better Auth refuses the sign-up, and the invite
   * role is applied on success — the same contract as /api/invitations/accept.
   */
  const authHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(request.url, context.env.PUBLIC_BASE_URL);
    const isSignUp = url.pathname.endsWith('/sign-up/email');
    let claimed: ClaimedInvitation | null = null;
    if (isSignUp) {
      const token = request.headers['x-invite-token'];
      const email = (request.body as { email?: string } | undefined)?.email;
      if (typeof token === 'string') {
        if (!email) throw AppError.forbidden('registration requires an invitation');
        const invite = await claimInvitation(context.db, token);
        if (!invite || invite.email.toLowerCase() !== email.toLowerCase()) {
          if (invite) await releaseInvitation(context.db, invite.id);
          throw AppError.forbidden('invalid invitation');
        }
        claimed = invite;
      } else if (!(await context.settings()).allowRegistration) {
        throw AppError.forbidden('registration requires an invitation');
      }
    }

    const headers = fromNodeHeaders(request.headers);
    // Never trust this marker from a client; only a successfully claimed invite
    // makes this sign-up eligible for the verified-onboarding path.
    headers.delete(TRUSTED_SIGNUP_HEADER);
    if (claimed) headers.set(TRUSTED_SIGNUP_HEADER, 'true');
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
      // Better Auth writes on its own connection and answers a duplicate address
      // with a generic 200. Bind the invite role to the returned persisted id and
      // address instead of optimistically updating by email.
      const buffer = Buffer.from(await response.arrayBuffer());
      if (response.status < 400) {
        const created = createdAccount(buffer);
        const applied = await completeInvitationSignup(context.db, claimed, created);
        if (!applied) throw AppError.conflict('an account with this e-mail already exists');
      } else {
        await releaseInvitation(context.db, claimed.id);
      }
      reply.code(response.status);
      for (const [key, value] of response.headers.entries()) {
        if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
        if (key.toLowerCase() === 'set-cookie') continue;
        reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(buffer.length > 0 ? buffer : null);
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
  await registerTaskShareRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerAdminRoutes(app, context);
  // Registered last so the API routes keep precedence over the SPA wildcard.
  await registerWebApp(app, webRoot);

  app.addHook('onClose', async () => {
    const { closeBoss } = await import('./lib/queue.js');
    await closeBoss();
  });

  return app;
}
