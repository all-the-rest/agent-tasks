import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness';
import type { TestHarness } from '../helpers/harness';
import { WEB_CONTENT_SECURITY_POLICY } from '../../apps/api/src/static';

let harness: TestHarness;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-tasks-web-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(root, 'assets', 'app-123.js'), 'console.log("spa");');
  await writeFile(join(root, '.env'), 'SECRET=do-not-serve');
  harness = await createHarness({ WEB_ROOT: root });
});

afterAll(async () => {
  await harness.close();
  await rm(root, { recursive: true, force: true });
});

describe('SPA served by the API image', () => {
  it('serves index.html for browser navigations, including client-side routes', async () => {
    for (const url of ['/', '/tasks/00000000-0000-0000-0000-000000000000', '/memory?scope=global']) {
      const response = await harness.app.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers.vary).toContain('Accept');
      expect(response.body).toContain('<div id="root"></div>');
    }
  });

  it('keeps the JSON 404 contract for API routes and missing assets', async () => {
    const api = await harness.app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { accept: 'text/html' },
    });
    expect(api.statusCode).toBe(404);
    expect(api.headers.vary).toContain('Accept');
    expect(api.headers['content-security-policy']).toBe(WEB_CONTENT_SECURITY_POLICY);
    expect(api.json()).toMatchObject({ error: { code: 'not_found' } });

    const asset = await harness.app.inject({
      method: 'GET',
      url: '/assets/missing.js',
      headers: { accept: 'text/html' },
    });
    expect(asset.statusCode).toBe(404);
    expect(asset.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('refuses dotfiles in the SPA root', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/.env',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('do-not-serve');
  });

  it('serves hashed assets immutably with the security headers', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toBe(WEB_CONTENT_SECURITY_POLICY);
    expect(response.body).toContain('spa');
  });
});
