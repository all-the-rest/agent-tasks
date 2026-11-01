import { createServer } from 'node:http';
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
}

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
  blocked: Array<{ host: string; reason: string; at: number }>;
}

const CONNECT_TIMEOUT_MS = 10_000;

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
    checkUrl(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`, { allowedPorts: options.allowedPorts, allowHttp: true });
    const addresses = await resolvePublicAddresses(host, lookupFn);
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

        const upstream = connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS }, () => {
          const headers = Object.entries(request.headers)
            .filter(([key]) => !['proxy-connection', 'proxy-authorization'].includes(key.toLowerCase()))
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`)
            .join('\r\n');
          upstream.write(`${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
          request.pipe(upstream);
          upstream.pipe(response);
        });
        upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
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
        const upstream = connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS }, () => {
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
