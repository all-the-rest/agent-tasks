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

  it('accepts a bracketed public IPv6 literal and returns it bare', () => {
    const checked = checkUrl('https://[2606:4700:4700::1111]/dns-query?name=example.com');
    expect(checked.hostname).toBe('2606:4700:4700::1111');
    expect(checked.url.hostname).toBe('[2606:4700:4700::1111]');
    expect(checked.url.href).toBe('https://[2606:4700:4700::1111]/dns-query?name=example.com');
    expect(checked.port).toBe(443);
  });

  it('accepts a bracketed public IPv6 literal on an explicitly allowed port', () => {
    const checked = checkUrl('http://[2001:4860:4860::8888]:8080/status', { allowedPorts: [8080] });
    expect(checked.hostname).toBe('2001:4860:4860::8888');
    expect(checked.url.hostname).toBe('[2001:4860:4860::8888]');
    expect(checked.port).toBe(8080);
    expect(() => checkUrl('http://[2001:4860:4860::8888]:8443/')).toThrow(/port 8443/);
  });

  it.each([
    'http://localhost/admin',
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::]/',
    'http://[fd00::1]/',
    'http://[fd00:ec2::254]/',
    'http://[2001:db8::1]/',
    'http://[2002::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[64:ff9b::a00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://host.docker.internal:5432/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
  ])('blocks %s', (url) => {
    expect(() => checkUrl(url)).toThrow(NetworkPolicyError);
  });

  it.each([
    'http://[2606:4700:4700::1111/',
    'http://2606:4700:4700::1111]/',
    'http://[]/',
    'http://[not-an-ip]/',
    'http://[example.com]/',
    'http://[[::1]]/',
  ])('rejects malformed bracketed host %s', (url) => {
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

  it('strips brackets only from valid IPv6 literals', () => {
    expect(normalizeHostname('[2606:4700:4700::1111]')).toBe('2606:4700:4700::1111');
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('[::FFFF:127.0.0.1]')).toBe('::ffff:127.0.0.1');
    expect(normalizeHostname('[fe80::1]')).toBe('fe80::1');
  });

  it('rejects malformed bracket forms instead of guessing', () => {
    expect(normalizeHostname('[2606:4700:4700::1111')).toBeNull();
    expect(normalizeHostname('2606:4700:4700::1111]')).toBeNull();
    expect(normalizeHostname('[]')).toBeNull();
    expect(normalizeHostname('[example.com]')).toBeNull();
    expect(normalizeHostname('[2606:4700:4700::1111]:443')).toBeNull();
    expect(normalizeHostname('[[::1]]')).toBeNull();
  });
});
