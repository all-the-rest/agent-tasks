import type { FastifyRequest } from 'fastify';

/**
 * Trust exactly one reverse-proxy hop. `trustProxy: true` trusts every entry in
 * `X-Forwarded-For`, so a client behind a proxy that appends instead of replacing
 * the header can choose its own rate-limit and audit address.
 *
 * Fastify's public type accepts a predicate, not the hop count that `proxy-addr`
 * supports. Hop 0 is the direct socket peer; trusting only that hop makes the
 * rightmost forwarded address (the one the proxy added) the client address.
 */
export function proxyTrust(value: string | undefined): boolean | ((address: string, hop: number) => boolean) {
  return value === 'true' ? (_address: string, hop: number) => hop === 0 : false;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The container healthcheck must not consume the per-IP budget, but the health
 * endpoint still reaches the database. Only the in-container loopback address
 * bypasses the global limiter; a proxied or remote request stays limited.
 */
export function isUnlimitedHealthCheck(request: Pick<FastifyRequest, 'url' | 'ip'>): boolean {
  return request.url === '/api/healthz' && LOOPBACK.has(request.ip);
}
