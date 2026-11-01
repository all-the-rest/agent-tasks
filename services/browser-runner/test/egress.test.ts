import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { get as httpGet } from 'node:http';
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

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('timeout')));
  });
}

describe('egress proxy', () => {
  let proxy: EgressProxy;

  beforeAll(async () => {
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
    });
  });

  afterAll(async () => {
    await proxy.close();
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
