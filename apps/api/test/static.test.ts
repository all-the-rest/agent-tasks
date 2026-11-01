import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSpaNavigation, registerWebApp, resolveWebRoot, WEB_CONTENT_SECURITY_POLICY, WEB_CSP_DIRECTIVES } from '../src/static.js';
import type { FastifyRequest } from 'fastify';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-tasks-web-root-'));
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function request(overrides: Partial<FastifyRequest>): FastifyRequest {
  return { method: 'GET', url: '/', headers: {}, ...overrides } as FastifyRequest;
}

describe('SPA root resolution', () => {
  it('accepts an existing build and ignores a missing one outside production', () => {
    expect(resolveWebRoot(root, 'development')).toBe(root);
    expect(resolveWebRoot(undefined, 'development')).toBeNull();
    expect(resolveWebRoot('/does/not/exist', 'test')).toBeNull();
  });

  it('fails fast in production when the SPA is missing', () => {
    expect(() => resolveWebRoot(undefined, 'production')).toThrow(/WEB_ROOT is required/);
    expect(() => resolveWebRoot('/does/not/exist', 'production')).toThrow(/does not contain index\.html/);
  });
});

describe('static serving policy', () => {
  it('renders one CSP string from the directives used by helmet', () => {
    expect(WEB_CSP_DIRECTIVES.frameAncestors).toEqual(["'none'"]);
    expect(WEB_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:;connect-src 'self';frame-ancestors 'none';base-uri 'self';form-action 'self'",
    );
  });

  it('sets the CSP on static files and refuses dotfiles', async () => {
    const app = Fastify();
    await registerWebApp(app, root);
    await writeFile(join(root, '.env'), 'SECRET=do-not-serve');

    const index = await app.inject({ method: 'GET', url: '/index.html' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toBe(WEB_CONTENT_SECURITY_POLICY);

    const dotfile = await app.inject({ method: 'GET', url: '/.env' });
    expect(dotfile.statusCode).toBe(404);
    expect(dotfile.body).not.toContain('do-not-serve');
    await app.close();
  });
});

describe('SPA navigation guard', () => {
  it('serves the shell for the root and HTML navigations only', () => {
    expect(isSpaNavigation(request({ url: '/', headers: { accept: 'application/json' } }))).toBe(true);
    expect(isSpaNavigation(request({ url: '/tasks/abc', headers: { accept: 'text/html' } }))).toBe(true);
    expect(isSpaNavigation(request({ url: '/tasks/abc', headers: { accept: 'application/json' } }))).toBe(false);
    expect(isSpaNavigation(request({ url: '/api/tasks', headers: { accept: 'text/html' } }))).toBe(false);
    expect(isSpaNavigation(request({ url: '/API/tasks', headers: { accept: 'text/html' } }))).toBe(false);
    expect(isSpaNavigation(request({ url: '/.git/config', headers: { accept: 'text/html' } }))).toBe(false);
    expect(isSpaNavigation(request({ url: '/assets/missing.js', headers: { accept: 'text/html' } }))).toBe(false);
    expect(isSpaNavigation(request({ method: 'POST', url: '/tasks/abc', headers: { accept: 'text/html' } }))).toBe(false);
  });
});
