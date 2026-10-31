/**
 * Invitation links are account-creation credentials that stay valid for seven days.
 * Fastify's default request serializer logs `req.url`, so `GET /api/invitations/<token>`
 * and `/invite/<token>` would put the token into every request log line. Mask the
 * token segment while keeping the route recognisable.
 */
const INVITATION_PATH = /^(\/(?:api\/invitations|invite)\/)([^/?#]+)(.*)$/;

export function redactRequestUrl(url: string): string {
  const suffixIndex = url.search(/[?#]/);
  const path = suffixIndex === -1 ? url : url.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : url.slice(suffixIndex);
  const match = path.match(INVITATION_PATH);
  if (!match) return url;
  const [, prefix, segment, rest] = match;
  // `POST /api/invitations/accept` is a route name, not a token; its token lives in the body.
  if (segment === 'accept') return url;
  return `${prefix}***${rest}${suffix}`;
}

export interface LoggedRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/** Same shape as Fastify's built-in `req` serializer, with the URL masked. */
export function requestSerializer(req: LoggedRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactRequestUrl(req.url ?? ''),
    version: req.headers && req.headers['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
