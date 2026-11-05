import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { createServer, get as httpGet } from 'node:http';
import type { Server } from 'node:http';
import { chromiumEgressArgs } from '../src/browser.js';
import { startEgressProxy } from '../src/proxy.js';
import type { EgressProxy } from '../src/proxy.js';

function request(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body,
        ...(response.headers.location ? { location: response.headers.location } : {}),
      }));
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('timeout')));
  });
}

function getAbsolute(port: number, target: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      const url = new URL(target);
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const separator = response.indexOf('\r\n\r\n');
      const header = response.slice(0, separator);
      const body = response.slice(separator + 4);
      const status = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
      const location = header.match(/^location:\s*(.+)$/im)?.[1];
      resolve({ status, body, ...(location ? { location } : {}) });
    });
    socket.on('error', reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error('timeout')));
  });
}

describe('egress proxy', () => {
  let proxy: EgressProxy;
  let upstream: Server;
  let upstreamPort: number;
  const connectHosts: string[] = [];

  beforeAll(async () => {
    upstream = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://rebind.internal.example/private' }).end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('fixture server failed to bind');
    upstreamPort = address.port;

    proxy = await startEgressProxy({
      allowedPorts: [80, 443, 8080],
      allowHttp: true,
      // Deterministic DNS: every hostname resolves to a public address except the
      // rebinding fixture, which resolves to a private one.
      lookupFn: async (host) => {
        if (host === 'rebind.internal.example') return [{ address: '10.0.0.7', family: 4 }];
        if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
        return [{ address: '10.1.2.3', family: 4 }];
      },
      connectFn: (options, connectionListener) => {
        connectHosts.push(options.host);
        return connect({ host: '127.0.0.1', port: upstreamPort }, connectionListener);
      },
    });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('refuses loopback targets', async () => {
    const response = await request(proxy.port, '127.0.0.1:80');
    expect(response).toContain('403');
    expect(proxy.blocked.some((entry) => entry.host === '127.0.0.1')).toBe(true);
  });

  it('answers a malformed absolute-form request instead of crashing', async () => {
    const malformed = await get(proxy.port, '/admin');
    expect(malformed.status).toBe(403);
    expect(malformed.body).toContain('blocked by egress policy');
    // The process is still serving after the malformed request.
    expect(await request(proxy.port, '127.0.0.1:80')).toContain('403');
  });

  it('removes Chromium\'s implicit loopback bypass and pins name resolution to the proxy', async () => {
    const args = chromiumEgressArgs(proxy.port);
    expect(args).toContain(`--proxy-server=http://127.0.0.1:${proxy.port}`);
    // An empty bypass list still leaves loopback direct; `<-loopback>` removes it.
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).not.toContain('--proxy-bypass-list=');
    expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    // Even when Chromium proxies loopback because of the new flags, the proxy refuses it.
    expect(await request(proxy.port, '127.0.0.1:80')).toContain('403');
  });

  it('refuses private-network targets', async () => {
    const response = await request(proxy.port, '192.168.0.10:443');
    expect(response).toContain('403');
  });

  it('refuses a hostname that resolves into a private network (DNS rebinding)', async () => {
    const response = await request(proxy.port, 'rebind.internal.example:443');
    expect(response).toContain('403');
    expect(proxy.blocked.some((entry) => entry.host === 'rebind.internal.example' && /non-public/.test(entry.reason))).toBe(true);
  });

  it('refuses ports outside the allowlist', async () => {
    const response = await request(proxy.port, 'public.example:5432');
    expect(response).toContain('403');
  });

  it('refuses IPv6 loopback and link-local targets', async () => {
    expect(await request(proxy.port, '[::1]:443')).toContain('403');
    expect(await request(proxy.port, '[fe80::1]:443')).toContain('403');
  });

  it('tunnels a bracketed public IPv6 literal and pins it without a DNS lookup', async () => {
    const response = await request(proxy.port, '[2606:4700:4700::1111]:443');
    expect(response).toContain('200 Connection Established');
    // The checked literal is the connect target, not the bracketed URL form.
    expect(connectHosts.at(-1)).toBe('2606:4700:4700::1111');
  });

  it('accepts a bracketed public IPv6 literal in an absolute-form request', async () => {
    const response = await getAbsolute(proxy.port, 'http://[2606:4700:4700::1111]/start');
    expect(response.status, JSON.stringify(response)).toBe(302);
    expect(connectHosts.at(-1)).toBe('2606:4700:4700::1111');
  });

  it.each([
    '[::]:443',
    '[fd00::1]:443',
    '[fd00:ec2::254]:443',
    '[fd00::1]:80',
    '[2001:db8::1]:443',
    '[2002::1]:443',
    '[ff02::1]:443',
    '[::ffff:127.0.0.1]:443',
    '[::ffff:10.0.0.1]:443',
    '[::ffff:169.254.169.254]:443',
    '[64:ff9b::a00:1]:443',
    '[64:ff9b::7f00:1]:443',
  ])('refuses blocked IPv6 target %s', async (authority) => {
    const before = proxy.blocked.length;
    expect(await request(proxy.port, authority)).toContain('403');
    expect(proxy.blocked.length).toBeGreaterThan(before);
  });

  it.each([
    'http://[]/',
    'http://[not-an-ip]/',
    'http://[example.com]/',
    'http://[2606:4700:4700::1111/',
    'http://2606:4700:4700::1111]/',
  ])('refuses malformed bracketed absolute-form target %s', async (target) => {
    const response = await get(proxy.port, target);
    expect(response.status).toBe(403);
    expect(response.body).toContain('blocked by egress policy');
  });

  it.each([
    '[2606:4700:4700::1111:443',
    '2606:4700:4700::1111]:443',
    '[]:443',
    '[not-an-ip]:443',
    '[example.com]:443',
  ])('refuses malformed bracketed authority %s', async (authority) => {
    expect(await request(proxy.port, authority)).toContain('403');
  });

  it('re-validates the destination of a real redirect before opening its socket', async () => {
    const firstHop = await getAbsolute(proxy.port, 'http://public.example/start');
    expect(firstHop.status, JSON.stringify(firstHop)).toBe(302);
    expect(firstHop.location).toBe('http://rebind.internal.example/private');

    // Simulate Chromium following Location with a new absolute-form proxy request.
    // The second target is rejected before connectFn can open the fixture socket.
    const before = proxy.blocked.length;
    const blockedHop = await getAbsolute(proxy.port, firstHop.location);
    expect(blockedHop.status).toBe(403);
    expect(blockedHop.body).toContain('blocked by egress policy');
    expect(proxy.blocked.length).toBeGreaterThan(before);
    expect(proxy.blocked.slice(before).some((entry) => entry.host === 'rebind.internal.example')).toBe(true);

    const repeated = await getAbsolute(proxy.port, firstHop.location);
    expect(repeated.status).toBe(403);
    expect(proxy.blocked.slice(before).filter((entry) => entry.host === 'rebind.internal.example')).toHaveLength(2);
  });

  it('fetches robots through the pinned egress path and revalidates redirect targets', async () => {
    const before = proxy.blocked.length;
    await expect(proxy.fetchRobots('http://public.example/robots.txt', 'AgentTasksResearchBot/0.2'))
      .rejects.toThrow(/non-public|not allowed|blocked/);
    expect(connectHosts.at(-1)).toBe('93.184.216.34');
    expect(connectHosts).not.toContain('10.0.0.7');
    expect(proxy.blocked.length).toBeGreaterThan(before);
    expect(proxy.blocked.slice(before).some((entry) => entry.host === 'rebind.internal.example')).toBe(true);
  });

  it('bounds robots redirects and response size without contacting the public network', async () => {
    let mode: 'redirect' | 'large' = 'redirect';
    let requests = 0;
    const fixture = createServer((_request, response) => {
      requests += 1;
      if (mode === 'redirect') {
        response.writeHead(302, { location: 'http://public.example/robots.txt' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(512 * 1024 + 1));
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('robots fixture failed to bind');
    const boundedProxy = await startEgressProxy({
      allowedPorts: [80],
      allowHttp: true,
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      connectFn: (_options, connectionListener) => connect({ host: '127.0.0.1', port: address.port }, connectionListener),
    });

    try {
      await expect(boundedProxy.fetchRobots('http://public.example/robots.txt', 'AgentTasksResearchBot/0.2'))
        .rejects.toThrow('robots redirect limit exceeded');
      expect(requests).toBe(6);
      mode = 'large';
      requests = 0;
      await expect(boundedProxy.fetchRobots('http://public.example/robots.txt', 'AgentTasksResearchBot/0.2'))
        .rejects.toThrow('robots response exceeded size limit');
      expect(requests).toBe(1);
    } finally {
      await boundedProxy.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it('times out a stalled DNS lookup before opening a robots connection', async () => {
    const timedProxy = await startEgressProxy({
      allowedPorts: [80],
      allowHttp: true,
      lookupFn: () => new Promise<Array<{ address: string; family: number }>>(() => undefined),
    });
    vi.useFakeTimers();
    try {
      const pending = timedProxy.fetchRobots('http://public.example/robots.txt', 'AgentTasksResearchBot/0.2');
      const rejected = expect(pending).rejects.toThrow('robots request timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
    } finally {
      vi.useRealTimers();
      await timedProxy.close();
    }
  });

  it('tunnels a public target when the network answers', async () => {
    // The tunnel is only established after the address passed the policy check.
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '93.184.216.34', port: 443 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.setTimeout(3_000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(false));
    });
    if (!reachable) {
      // No outbound internet in this environment: the positive path is covered by
      // the compose smoke test instead of being pretended here.
      return;
    }
    const response = await request(proxy.port, 'public.example:443');
    expect(response).toContain('200 Connection Established');
  });
});
