import { readFileSync } from 'node:fs';
import { WEB_CONTENT_SECURITY_POLICY } from '@agent-tasks/shared';
import { describe, expect, it } from 'vitest';

/**
 * The production image serves the built index.html under
 * `script-src 'self'`. Any inline script would be blocked, so the theme
 * bootstrap must live in the bundled entrypoint instead.
 */
function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('production index and CSP', () => {
  it('has no inline scripts', () => {
    const html = read('../index.html');
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(inlineScripts.map((match) => match[1])).toEqual([]);
  });

  it('applies the theme from the bundled entrypoint', () => {
    expect(read('../src/main.tsx')).toContain("import './lib/theme-bootstrap';");
    expect(read('../src/lib/theme-bootstrap.ts')).toContain('applyTheme(storedTheme())');
  });

  it('serves scripts only from self, without unsafe-inline', () => {
    expect(WEB_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
