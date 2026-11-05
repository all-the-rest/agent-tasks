/**
 * Invitation, share and auth links can contain bearer credentials. Fastify's
 * default request serializer logs `req.url`, so mask known token path segments and
 * every `token` query value, including absolute-form request targets.
 */
const BEARER_PATH = /^(.*\/(?:api\/invitations|invite|api\/shares|share|api\/auth\/reset-password)\/)([^/?#]+)(.*)$/;
const BEARER_QUERY_TOKEN = /([?&]token=)[^&#]*/gi;
const ABSOLUTE_TARGET = /^([a-z][a-z\d+.-]*:\/\/[^/?#]+)(.*)$/i;

export function redactRequestUrl(url: string): string {
  const absolute = ABSOLUTE_TARGET.exec(url);
  const authority = absolute?.[1] ?? '';
  const target = absolute?.[2] ?? url;
  const suffixIndex = target.search(/[?#]/);
  const path = suffixIndex === -1 ? target : target.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : target.slice(suffixIndex);
  const match = path.match(BEARER_PATH);
  const redactedPath = match && match[2] !== 'accept'
    ? `${match[1]}***${match[3]}`
    : path;
  const redactedSuffix = suffix.replace(BEARER_QUERY_TOKEN, '$1***');
  return `${authority}${redactedPath}${redactedSuffix}`;
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
