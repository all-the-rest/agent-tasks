import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { BrowserPool } from '../src/browser.js';
import type { BrowserPoolDependencies } from '../src/browser.js';
import type { EgressProxy } from '../src/proxy.js';
import { CRAWLER_USER_AGENT } from '../src/robots-policy.js';
import type { RobotsResponse } from '../src/robots-policy.js';

const pools: BrowserPool[] = [];

function setupPool(responses: Record<string, RobotsResponse>) {
  const routeHandlers: Array<(route: Route) => Promise<void>> = [];
  const mainFrames: object[] = [];
  const fetchRobots = vi.fn(async (url: string): Promise<RobotsResponse> => (
    responses[new URL(url).origin] ?? { status: 404, body: '' }
  ));
  const proxy = {
    port: 32123,
    blocked: [],
    close: vi.fn().mockResolvedValue(undefined),
    fetchRobots,
  } as unknown as EgressProxy;
  const makeContext = (): BrowserContext => {
    const mainFrame: { page: () => { mainFrame: () => object } } = {
      page: () => ({ mainFrame: () => mainFrame }),
    };
    const sessionIndex = mainFrames.length;
    mainFrames.push(mainFrame);
    let currentUrl = 'about:blank';
    const page = {
      mainFrame: () => mainFrame,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      url: () => currentUrl,
      title: vi.fn().mockResolvedValue('Fixture page'),
      evaluate: vi.fn().mockResolvedValue('Fixture text'),
      goto: vi.fn(async (url: string) => {
        const request = {
          url: () => url,
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          redirectedFrom: () => null,
        };
        const route = {
          request: () => request,
          continue: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
        };
        const handler = routeHandlers[sessionIndex];
        if (!handler) throw new Error('navigation route was not installed');
        await handler(route as unknown as Route);
        if (route.abort.mock.calls.length > 0) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
        currentUrl = url;
      }),
    } as unknown as Page;
    return {
      newPage: vi.fn().mockResolvedValue(page),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => {
        routeHandlers.push(handler);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
  };
  const browser = {
    newContext: vi.fn().mockImplementation(async () => makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
    version: vi.fn(() => 'test-browser'),
  } as unknown as Browser;
  vi.spyOn(chromium, 'launch').mockResolvedValue(browser);

  const dependencies: BrowserPoolDependencies = {
    startProxy: vi.fn().mockResolvedValue(proxy) as unknown as typeof import('../src/proxy.js').startEgressProxy,
  };
  const pool = new BrowserPool(
    { maxSessions: 2, sessionTtlMs: 60_000, actionTimeoutMs: 1_000, maxTextChars: 1_000 },
    { allowedPorts: [80, 443], allowHttp: false, chromiumSandbox: false },
    dependencies,
  );
  pools.push(pool);

  return pool.start().then(async () => {
    const id = await pool.create();
    const sessionContextOptions = vi.mocked(browser.newContext).mock.calls[0]?.[0];
    const navigate = async (
      url: string,
      isNavigation = true,
      redirected = false,
      sessionIndex = 0,
      popupMainFrame = false,
    ) => {
      const routeHandler = routeHandlers[sessionIndex];
      if (!routeHandler) throw new Error('navigation route was not installed');
      let frame = mainFrames[sessionIndex];
      if (popupMainFrame) {
        const popupFrame: { page: () => { mainFrame: () => object } } = {
          page: () => ({ mainFrame: () => popupFrame }),
        };
        frame = popupFrame;
      }
      const request = {
        url: () => url,
        isNavigationRequest: () => isNavigation,
        frame: () => isNavigation ? frame : {},
        redirectedFrom: () => redirected ? {} : null,
      };
      const route = {
        request: () => request,
        continue: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      } as unknown as Route;
      await routeHandler(route);
      return route as Route & { continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
    };
    return { pool, id, fetchRobots, navigate, sessionContextOptions };
  });
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
});

describe('browser robots policy', () => {
  it('checks allowed and disallowed main-frame paths and redirects, but not subresources', async () => {
    const fixture = await setupPool({
      'https://example.com': {
        status: 200,
        body: 'User-agent: AgentTasksResearchBot\nDisallow: /private',
      },
    });

    const allowed = await fixture.navigate('https://example.com/public');
    const denied = await fixture.navigate('https://example.com/private/report');
    const redirectTarget = await fixture.navigate('https://example.com/private/redirected', true, true);
    const popupNavigation = await fixture.navigate('https://example.com/private/popup', true, false, 0, true);
    const subresource = await fixture.navigate('https://example.com/private/image.png', false);

    expect(allowed.continue).toHaveBeenCalledTimes(1);
    expect(denied.abort).toHaveBeenCalledTimes(1);
    expect(redirectTarget.abort).toHaveBeenCalledTimes(1);
    expect(popupNavigation.abort).toHaveBeenCalledTimes(1);
    expect(subresource.continue).toHaveBeenCalledTimes(1);
    expect(fixture.fetchRobots).toHaveBeenCalledTimes(1);
    expect(fixture.fetchRobots).toHaveBeenCalledWith('https://example.com/robots.txt', CRAWLER_USER_AGENT);
    expect(fixture.sessionContextOptions?.userAgent).toBe(CRAWLER_USER_AGENT);
  });

  it('allows a missing robots file and fails closed when the robots server fails', async () => {
    const fixture = await setupPool({
      'https://missing.example': { status: 404, body: '' },
      'https://broken.example': { status: 503, body: '' },
    });

    const missing = await fixture.navigate('https://missing.example/page');
    const failed = await fixture.navigate('https://broken.example/page');

    expect(missing.continue).toHaveBeenCalledTimes(1);
    expect(failed.abort).toHaveBeenCalledTimes(1);
  });

  it('reports robots denial from an open_url browser action', async () => {
    const fixture = await setupPool({
      'https://example.com': {
        status: 200,
        body: 'User-agent: AgentTasksResearchBot\nDisallow: /private',
      },
    });

    const result = await fixture.pool.act(fixture.id, {
      action: 'open_url',
      url: 'https://example.com/private/report',
    });

    expect(result).toMatchObject({
      ok: false,
      action: 'open_url',
      error: 'navigation disallowed by robots.txt',
      blocked: 'robots.txt',
    });
  });

  it('does not share a robots cache between browser sessions', async () => {
    const fixture = await setupPool({ 'https://example.com': { status: 404, body: '' } });
    await fixture.pool.create();
    await fixture.navigate('https://example.com/one');
    await fixture.navigate('https://example.com/one', true, false, 1);
    expect(fixture.fetchRobots).toHaveBeenCalledTimes(2);
  });
});
