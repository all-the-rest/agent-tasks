import { Agent, createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkUrl, NetworkPolicyError, resolvePublicAddresses } from '@agent-tasks/shared';
import type { RobotsFetcher, RobotsResponse } from './robots-policy.js';

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
  /** Fetches robots.txt through this proxy's URL/DNS/IP validation and pinned connector. */
  fetchRobots(url: string, userAgent: string): Promise<RobotsResponse>;
}

interface EgressResponse extends RobotsResponse {
  location?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_MAX_REDIRECTS = 5;
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
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy & RobotsFetcher> {
  const blocked: EgressProxy['blocked'] = [];
  const lookupFn = options.lookupFn ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const connectFn = options.connectFn ?? connect;

  const recordBlocked = (host: string, reason: string): void => {
    blocked.push({ host, reason, at: Date.now() });
    if (blocked.length > 200) blocked.shift();
    options.onBlock?.(host, reason);
  };

  const deny = (response: ServerResponse | Socket, host: string, reason: string): void => {
    recordBlocked(host, reason);
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

  const requestRobotsHop = async (target: URL, userAgent: string): Promise<EgressResponse> => {
    const deadlineAt = Date.now() + ROBOTS_TIMEOUT_MS;
    const checked = checkUrl(target, { allowedPorts: options.allowedPorts, allowHttp: options.allowHttp });
    const destination = checked.url;
    let address: string;
    let lookupDeadline: NodeJS.Timeout | undefined;
    try {
      address = await Promise.race([
        validatedTarget(checked.hostname, checked.port, destination.toString()),
        new Promise<never>((_resolve, reject) => {
          lookupDeadline = setTimeout(
            () => reject(new Error('robots request timed out')),
            Math.max(1, deadlineAt - Date.now()),
          );
        }),
      ]);
    } catch (error) {
      recordBlocked(checked.hostname, error instanceof Error ? error.message : 'blocked by egress policy');
      throw error;
    } finally {
      if (lookupDeadline) clearTimeout(lookupDeadline);
    }
    const timeoutMs = deadlineAt - Date.now();
    if (timeoutMs <= 0) throw new Error('robots request timed out');
    const isHttps = destination.protocol === 'https:';
    const port = checked.port;
    const agent = isHttps ? new HttpsAgent({ keepAlive: false }) : new Agent({ keepAlive: false });

    if (isHttps) {
      const secureAgent = agent as HttpsAgent;
      secureAgent.createConnection = ((_connectionOptions, callback) => {
        const rawSocket = connectFn({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
        const secureSocket = tlsConnect({
          socket: rawSocket,
          servername: isIP(checked.hostname) ? undefined : checked.hostname,
          checkServerIdentity: (_serverName, certificate) => checkServerIdentity(checked.hostname, certificate),
          rejectUnauthorized: true,
        });
        if (!callback) return secureSocket;
        secureSocket.once('secureConnect', () => callback(null, secureSocket));
        secureSocket.once('error', (error) => callback(error, secureSocket));
        return undefined as unknown as Duplex;
      }) as typeof secureAgent.createConnection;
    } else {
      const plainAgent = agent as Agent;
      plainAgent.createConnection = ((_connectionOptions, callback) => {
        const socket = connectFn({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
        if (callback) socket.once('connect', () => callback(null, socket));
        return socket;
      }) as typeof plainAgent.createConnection;
    }

    return new Promise<EgressResponse>((resolve, reject) => {
      let settled = false;
      let received = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, result?: EgressResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        agent.destroy();
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('robots response was empty'));
      };
      const deadline = setTimeout(() => request.destroy(new Error('robots request timed out')), timeoutMs);
      const request = (isHttps ? httpsRequest : httpRequest)(destination, {
        method: 'GET',
        agent,
        headers: {
          'user-agent': userAgent,
          accept: 'text/plain, */*;q=0.1',
          'accept-encoding': 'identity',
          connection: 'close',
        },
      }, (response) => {
        const contentEncoding = response.headers['content-encoding'];
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300
          && typeof contentEncoding === 'string' && contentEncoding.toLowerCase() !== 'identity') {
          response.once('error', (error) => finish(error));
          response.destroy(new Error('unsupported robots content encoding'));
          return;
        }
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.byteLength;
          if (received > ROBOTS_MAX_BYTES) {
            response.destroy(new Error('robots response exceeded size limit'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('end', () => finish(undefined, {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          ...(typeof response.headers.location === 'string' ? { location: response.headers.location } : {}),
        }));
        response.once('error', (error) => finish(error));
      });
      request.once('error', (error) => finish(error));
      request.setTimeout(timeoutMs, () => request.destroy(new Error('robots request timed out')));
      request.end();
    });
  };

  const fetchRobots = async (rawUrl: string, userAgent: string): Promise<RobotsResponse> => {
    let current = checkUrl(rawUrl, { allowedPorts: options.allowedPorts, allowHttp: options.allowHttp }).url;
    if (current.pathname !== '/robots.txt' || current.search) {
      throw new NetworkPolicyError('robots fetch must start at the origin robots.txt path', current.toString());
    }
    for (let redirects = 0; ; redirects += 1) {
      const response = await requestRobotsHop(current, userAgent);
      const isRedirect = response.status >= 300 && response.status < 400 && response.location;
      if (!isRedirect) return { status: response.status, body: response.body };
      if (redirects >= ROBOTS_MAX_REDIRECTS) throw new Error('robots redirect limit exceeded');
      // Resolve and validate every hop before the next connection; redirects cannot
      // turn this helper into an unrestricted URL fetch.
      current = checkUrl(new URL(response.location as string, current), {
        allowedPorts: options.allowedPorts,
        allowHttp: options.allowHttp,
      }).url;
    }
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
    fetchRobots,
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
