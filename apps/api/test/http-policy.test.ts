import { describe, expect, it } from 'vitest';
import { isUnlimitedHealthCheck, proxyTrust } from '../src/http-policy.js';

describe('proxy trust', () => {
  it('trusts exactly one hop when TRUST_PROXY is enabled', () => {
    const trust = proxyTrust('true');
    expect(typeof trust).toBe('function');
    if (typeof trust === 'function') {
      expect(trust('127.0.0.1', 0)).toBe(true);
      expect(trust('203.0.113.10', 1)).toBe(false);
    }
    expect(proxyTrust('false')).toBe(false);
    expect(proxyTrust(undefined)).toBe(false);
  });
});

describe('healthcheck rate-limit bypass', () => {
  it('only exempts the health path from loopback', () => {
    expect(isUnlimitedHealthCheck({ url: '/api/healthz', ip: '127.0.0.1' })).toBe(true);
    expect(isUnlimitedHealthCheck({ url: '/api/healthz', ip: '::1' })).toBe(true);
    expect(isUnlimitedHealthCheck({ url: '/api/healthz', ip: '203.0.113.10' })).toBe(false);
    expect(isUnlimitedHealthCheck({ url: '/api/healthz?full=1', ip: '127.0.0.1' })).toBe(false);
    expect(isUnlimitedHealthCheck({ url: '/api/tasks', ip: '127.0.0.1' })).toBe(false);
  });
});
