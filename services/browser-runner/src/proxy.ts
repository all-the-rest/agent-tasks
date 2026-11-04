import { Agent, createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkUrl, NetworkPolicyError, resolvePublicAddresses } from '@agent-tasks/shared';

export interface EgressProxyOptions {
  allowedPorts: number[];
  allowHttp: boolean;
  /** Called for every blocked request; never contains credentials. */
  onBlock?: (host: string, reason: string) => void;
  lookupFn?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam for simulating a checked public destination without outbound networking. */
  connectFn?: (options: { host: string; port: number; timeout?: number }, connectionListener?: () => void) => Socket;
}

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
  blocked: Array<{ host: string; reason: string; at: number }>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Best-effort host for the block log. A malformed request target must not throw
 * from the error path: an uncaught `new URL()` here would terminate the runner.
 */
function hostOf(raw: string | undefined): string {
  if (!raw) return 'unknown';
  try {
    return new URL(raw).hostname;
  } catch {
    return 'unknown';
  }
}

function splitHostPort(authority: string, fallbackPort: number): { host: string; port: number } {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    const host = authority.slice(1, end);
    const port = authority.slice(end + 2);
    return { host, port: port ? Number(port) : fallbackPort };
  }
  const lastColon = authority.lastIndexOf(':');
  if (lastColon === -1) return { host: authority, port: fallbackPort };
  const host = authority.slice(0, lastColon);
  const port = Number(authority.slice(lastColon + 1));
  return { host, port: Number.isFinite(port) ? port : fallbackPort };
}

/**
 * An enforcing HTTP proxy. Chromium is launched with `--proxy-server` pointing at
 * this process, so every request — first hop and every redirect hop — passes the
 * policy. DNS is resolved here, all answers must be public, and the connection is
 * pinned to a checked address, which is what defeats DNS rebinding: the browser
 * never resolves a name itself.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const blocked: EgressProxy['blocked'] = [];
  const lookupFn = options.lookupFn ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const connectFn = options.connectFn ?? connect;

  const deny = (response: ServerResponse | Socket, host: string, reason: string): void => {
    blocked.push({ host, reason, at: Date.now() });
    if (blocked.length > 200) blocked.shift();
    options.onBlock?.(host, reason);
    const message = `blocked by egress policy: ${reason}`;
    if ('writeHead' in response) {
      response.writeHead(403, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(message) });
      response.end(message);
    } else {
      response.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    }
  };

  const validatedTarget = async (host: string, port: number, raw: string): Promise<string> => {
    if (!options.allowedPorts.includes(port)) throw new NetworkPolicyError(`port ${port} is not allowed`, raw);
    const checked = checkUrl(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`, { allowedPorts: options.allowedPorts, allowHttp: true });
    // `checkUrl` returns the bare IPv6 literal; an absolute-form HTTP request
    // reaches us with brackets still attached. Resolve the normalised host so a
    // public literal is pinned directly instead of being looked up as a name.
    const addresses = await resolvePublicAddresses(checked.hostname, lookupFn);
    const first = addresses[0];
    if (!first) throw new NetworkPolicyError(`host ${host} did not resolve`, raw);
    return first;
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        if (!request.url) throw new NetworkPolicyError('missing URL');
        if (!/^http:\/\//i.test(request.url)) throw new NetworkPolicyError('only absolute http URLs are proxied');
        const target = new URL(request.url);
        if (!options.allowHttp && target.protocol === 'http:') throw new NetworkPolicyError('plain http is disabled');
        const port = target.port ? Number(target.port) : 80;
        const address = await validatedTarget(target.hostname, port, request.url);

        const agent = new Agent({ keepAlive: false });
        agent.createConnection = (_connectionOptions, callback) => {
          const upstream = connectFn({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
          if (callback) upstream.once('connect', () => callback(null, upstream));
          return upstream;
        };
        const upstream = httpRequest(target, {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(([key]) => !HOP_BY_HOP_HEADERS.has(key.toLowerCase())),
          ),
          agent,
        });
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
        upstream.on('response', (upstreamResponse) => {
          const headers = Object.fromEntries(
            Object.entries(upstreamResponse.headers).filter(
              ([key, value]) => value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase()),
            ),
          );
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
          upstreamResponse.once('end', () => agent.destroy());
        });
        upstream.on('error', () => {
          agent.destroy();
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        response.once('close', () => upstream.destroy());
        request.pipe(upstream);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'blocked';
        deny(response, hostOf(request.url), reason);
      }
    })();
  });

  server.on('connect', (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      const authority = request.url ?? '';
      try {
        const { host, port } = splitHostPort(authority, 443);
        const address = await validatedTarget(host, port, authority);
        const upstream = connectFn({ host: address, port, timeout: CONNECT_TIMEOUT_MS }, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'blocked';
        deny(clientSocket, splitHostPort(authority, 443).host, reason);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('proxy failed to bind');

  return {
    port: address.port,
    blocked,
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
