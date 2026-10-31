import { describe, expect, it } from 'vitest';
import type { BrowserRunnerClient, BrowserResult, SearchProvider } from '@agent-tasks/browser-tools';
import { findTool, truncateToBytes } from '../src/index.js';
import type { ToolContext } from '../src/index.js';

const HUGE = 'x'.repeat(20_000);

const browser = {
  async act(_sessionId: string, action: { action: string; url?: string }): Promise<BrowserResult> {
    if (action.action === 'open_url' || action.action === 'extract_page_text') {
      return { ok: true, action: action.action, url: action.url ?? 'https://example.com/a', title: 'Fixture', text: HUGE };
    }
    if (action.action === 'inspect_page') {
      return {
        ok: true,
        action: 'inspect_page',
        url: 'https://example.com/a',
        elements: Array.from({ length: 80 }, (_, index) => ({ tag: 'a', text: `${index} ${HUGE}`, selector: `a:nth-of-type(${index + 1})` })),
      };
    }
    if (action.action === 'extract_links') {
      return {
        ok: true,
        action: 'extract_links',
        url: 'https://example.com/a',
        links: Array.from({ length: 100 }, (_, index) => ({ text: `${index}`, href: `https://example.com/${index}` })),
      };
    }
    return { ok: true, action: action.action, url: 'https://example.com/a' };
  },
  async createSession() {
    return { sessionId: 's1' };
  },
  async closeSession() {
    return undefined;
  },
} as unknown as BrowserRunnerClient;

const search: SearchProvider = {
  async search() {
    return Array.from({ length: 10 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: HUGE }));
  },
};

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    browser,
    sessionId: 's1',
    search,
    allowForms: false,
    visited: new Set<string>(),
    pageVisits: 0,
    queries: [],
    onSource: () => undefined,
    limits: { maxPageVisits: 5, maxSearchQueries: 5, maxOutputBytes: 50_000 },
    ...overrides,
  };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

describe('tool limits', () => {
  it('counts repeated URLs against the page-visit budget', async () => {
    const openUrl = findTool('open_url');
    const toolContext = context({ limits: { maxPageVisits: 2, maxSearchQueries: 5, maxOutputBytes: 50_000 } });

    const first = await openUrl?.run({ url: 'https://example.com/a' }, toolContext);
    const second = await openUrl?.run({ url: 'https://example.com/a' }, toolContext);
    const third = await openUrl?.run({ url: 'https://example.com/a' }, toolContext);

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(third?.ok).toBe(false);
    expect(third?.error).toBe('limit_exceeded');
    expect(toolContext.pageVisits).toBe(2);
  });

  it('enforces the visit budget for clicks and back-navigation too', async () => {
    const click = findTool('click_element');
    const back = findTool('navigate_back');
    const toolContext = context({ limits: { maxPageVisits: 1, maxSearchQueries: 5, maxOutputBytes: 50_000 } });

    expect((await click?.run({ selector: 'a' }, toolContext))?.ok).toBe(true);
    expect((await back?.run({}, toolContext))?.error).toBe('limit_exceeded');
  });

  it('truncates an oversized page to maxOutputBytes', async () => {
    const openUrl = findTool('open_url');
    const extract = findTool('extract_page_text');
    const toolContext = context({ limits: { maxPageVisits: 5, maxSearchQueries: 5, maxOutputBytes: 300 } });

    const opened = await openUrl?.run({ url: 'https://example.com/a' }, toolContext);
    expect(opened?.ok).toBe(true);
    expect(bytes(opened?.content ?? '')).toBeLessThanOrEqual(300);

    const extracted = await extract?.run({ maxChars: 50_000 }, toolContext);
    expect(extracted?.ok).toBe(true);
    expect(bytes(extracted?.content ?? '')).toBeLessThanOrEqual(300);
  });

  it('truncates search, inspect and link payloads to maxOutputBytes', async () => {
    const toolContext = context({ limits: { maxPageVisits: 5, maxSearchQueries: 5, maxOutputBytes: 500 } });

    const searchResult = await findTool('search_web')?.run({ query: 'fixture' }, toolContext);
    const inspectResult = await findTool('inspect_page')?.run({}, toolContext);
    const linksResult = await findTool('extract_links')?.run({}, toolContext);

    for (const result of [searchResult, inspectResult, linksResult]) {
      expect(result?.ok).toBe(true);
      expect(bytes(result?.content ?? '')).toBeLessThanOrEqual(500);
    }
  });

  it('truncateToBytes never exceeds the byte budget, even for multi-byte text', () => {
    for (const max of [1, 2, 3, 10, 100, 1_000]) {
      expect(bytes(truncateToBytes('🙂'.repeat(500), max))).toBeLessThanOrEqual(max);
    }
  });
});
