import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import { WEB_CONTENT_SECURITY_POLICY } from '@agent-tasks/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// The policy lives in the dependency-free shared package so the API, the static
// server and the web tests all consume the same generated header.
export { WEB_CSP_DIRECTIVES, WEB_CONTENT_SECURITY_POLICY } from '@agent-tasks/shared';

/** Absolute SPA directory, or null when this process has no built frontend (dev/tests). */
export function resolveWebRoot(configured: string | undefined, nodeEnv: string): string | null {
  if (!configured) {
    // Production images always set WEB_ROOT. A bundle started without it would
    // otherwise answer every browser route with a misleading 404 while healthy.
    if (nodeEnv === 'production') throw new Error('WEB_ROOT is required in production; the image sets it to the built SPA directory');
    return null;
  }
  if (!existsSync(join(configured, 'index.html'))) {
    if (nodeEnv === 'production') throw new Error(`WEB_ROOT does not contain index.html: ${configured}`);
    return null;
  }
  return configured;
}

/** Serves hashed `/assets/*` files and returns false when no SPA is present. */
export async function registerWebApp(app: FastifyInstance, root: string | null): Promise<boolean> {
  if (!root) return false;
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
    // The processed process holds AUTH_SECRET, provider keys and database
    // credentials. Never serve dotfiles even if an operator points WEB_ROOT at
    // an unclean directory.
    dotfiles: 'ignore',
    setHeaders(response, filePath) {
      response.header('X-Content-Type-Options', 'nosniff');
      response.header('X-Frame-Options', 'DENY');
      response.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.header('Content-Security-Policy', WEB_CONTENT_SECURITY_POLICY);
      // `sendFile` writes the file response after the not-found handler's header,
      // so the variant marker must be set here as well.
      response.header('Vary', 'Accept');
      // Vite content-hashes everything under /assets; index.html must be revalidated.
      response.header(
        'Cache-Control',
        filePath.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  return true;
}

/**
 * Only browser navigations fall back to index.html. API paths, missing assets and
 * non-HTML clients keep the JSON 404 contract.
 */
export function isSpaNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const pathname = request.url.split('?')[0] ?? '/';
  const lower = pathname.toLowerCase();
  // Case-insensitive so `/API/...` cannot be mistaken for a client route.
  if (lower === '/api' || lower.startsWith('/api/')) return false;
  // Dot-directories (/.git/config) are metadata, not client routes.
  if (pathname.split('/').some((segment) => segment.startsWith('.'))) return false;
  // `/` is always the app shell, so health probes with `curl -I` work too.
  if (pathname === '/') return true;
  if (!(request.headers.accept ?? '').includes('text/html')) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}
