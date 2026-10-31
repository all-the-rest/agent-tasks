import { describe, expect, it } from 'vitest';
import { NetworkPolicyError, checkUrl, classifyAddress, isPublicAddress, normalizeHostname } from '../src/index.js';

describe('address classification', () => {
  const expectations: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'carrier_nat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['198.18.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['fe80::1', 'link_local'],
    ['fd00::1', 'unique_local'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::a00:1', 'private'],
    ['2606:4700:4700::1111', 'public'],
  ];

  for (const [address, expected] of expectations) {
    it(`classifies ${address} as ${expected}`, () => {
      expect(classifyAddress(address)).toBe(expected);
      expect(isPublicAddress(address)).toBe(expected === 'public');
    });
  }
});

describe('url policy', () => {
  it('accepts a public https url and normalises the host', () => {
    const checked = checkUrl('https://Example.COM./path?x=1');
    expect(checked.hostname).toBe('example.com');
    expect(checked.port).toBe(443);
  });

  it.each([
    'http://localhost/admin',
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://host.docker.internal:5432/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
  ])('blocks %s', (url) => {
    expect(() => checkUrl(url)).toThrow(NetworkPolicyError);
  });

  it('blocks non-allowlisted ports', () => {
    expect(() => checkUrl('https://example.com:8443/')).toThrow(/port 8443/);
    expect(() => checkUrl('https://example.com:8443/', { allowedPorts: [8443] })).not.toThrow();
  });

  it('normalises IDN hosts to punycode', () => {
    expect(normalizeHostname('BÜCHER.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHostname('bad host')).toBeNull();
  });
});
