import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { browserActionSchema } from '@agent-tasks/browser-tools';
import type { BrowserAction, BrowserResult } from '@agent-tasks/browser-tools';
import { checkUrl } from '@agent-tasks/shared';
import type { EgressProxy } from './proxy.js';
import { startEgressProxy } from './proxy.js';

export interface RunnerLimits {
  maxSessions: number;
  sessionTtlMs: number;
  actionTimeoutMs: number;
  maxTextChars: number;
}

/**
 * Chromium flags that make the egress proxy the only way out of the browser.
 *
 * `--proxy-bypass-list=` does NOT remove Chromium's implicit bypass for loopback, so a
 * page could reach 127.0.0.1 directly. `<-loopback>` subtracts that implicit rule. The
 * host resolver is additionally pinned to NOTFOUND for every name (except 127.0.0.1,
 * needed to reach the proxy socket itself), so even a bypassed name cannot be resolved
 * by the browser; the proxy resolves and pins every checked address instead. WebRTC is
 * restricted to proxied UDP, because a non-proxied UDP path would sidestep both.
 */
export function chromiumEgressArgs(proxyPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-extensions',
    '--disable-domain-reliability',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions',
    '--metrics-recording-only',
    '--disable-breakpad',
  ];
}

export interface SessionState {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastActionAt: number;
  actions: number;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private proxy: EgressProxy | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly limits: RunnerLimits,
    private readonly options: { allowedPorts: number[]; allowHttp: boolean; chromiumSandbox: boolean },
  ) {}

  async start(): Promise<void> {
    this.proxy = await startEgressProxy({ allowedPorts: this.options.allowedPorts, allowHttp: this.options.allowHttp });
    this.browser = await chromium.launch({
      headless: true,
      // The sandbox stays enabled in every supported deployment: the container runs as a
      // non-root user and provides the setuid helper. RUNNER_CHROMIUM_SANDBOX=false exists
      // only for hosts without user namespaces and is logged loudly at startup.
      chromiumSandbox: this.options.chromiumSandbox,
      args: chromiumEgressArgs(this.proxy.port),
    });
    this.sweeper = setInterval(() => void this.sweep(), 15_000);
    this.sweeper.unref();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActionAt > this.limits.sessionTtlMs) {
        await this.destroy(id).catch(() => undefined);
      }
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Present once `start()` succeeded; proves a browser process is running. */
  get browserVersion(): string | null {
    return this.browser?.version() ?? null;
  }

  get blockedRequests(): Array<{ host: string; reason: string; at: number }> {
    return this.proxy?.blocked ?? [];
  }

  async create(): Promise<string> {
    if (!this.browser) throw new Error('browser not started');
    if (this.sessions.size >= this.limits.maxSessions) throw new Error('runner is at capacity');
    const context = await this.browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'UTC',
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.limits.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.limits.actionTimeoutMs);
    // Only http(s) leaves the browser; everything else is dropped before the proxy.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (!/^https?:/i.test(url)) return route.abort('blockedbyclient');
      return route.continue();
    });
    const id = randomUUID();
    this.sessions.set(id, { id, context, page, createdAt: Date.now(), lastActionAt: Date.now(), actions: 0 });
    return id;
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) await this.destroy(id);
    await this.browser?.close().catch(() => undefined);
    await this.proxy?.close().catch(() => undefined);
  }

  async act(id: string, raw: unknown): Promise<BrowserResult & { blocked?: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, action: 'unknown', error: 'unknown session' };
    const parsed = browserActionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, action: 'invalid', error: `invalid action: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
    const action = parsed.data;
    session.lastActionAt = Date.now();
    session.actions += 1;
    if (session.actions > 200) return { ok: false, action: action.action, error: 'action budget for this session exhausted' };

    try {
      return await this.dispatch(session, action);
    } catch (error) {
      const message = (error as Error).message;
      const blocked = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|blocked by egress policy|ERR_BLOCKED_BY_CLIENT/i.test(message);
      return {
        ok: false,
        action: action.action,
        error: blocked ? 'blocked by network policy' : message.slice(0, 300),
        blocked: blocked ? 'blocked by network policy' : undefined,
      };
    }
  }

  private async dispatch(session: SessionState, action: BrowserAction): Promise<BrowserResult> {
    const { page } = session;
    switch (action.action) {
      case 'open_url': {
        checkUrl(action.url, { allowedPorts: this.options.allowedPorts, allowHttp: this.options.allowHttp });
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.limits.actionTimeoutMs });
        const text = await this.readText(session, this.limits.maxTextChars);
        return { ok: true, action: 'open_url', url: page.url(), title: await page.title(), text };
      }
      case 'extract_page_text': {
        const text = await this.readText(session, Math.min(action.maxChars, this.limits.maxTextChars));
        return { ok: true, action: 'extract_page_text', url: page.url(), title: await page.title(), text };
      }
      case 'inspect_page': {
        const elements = await page.evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, input, select, textarea, h1, h2, h3'));
          return nodes.slice(0, 80).map((node, index) => {
            const element = node as HTMLElement;
            const tag = element.tagName.toLowerCase();
            return {
              tag,
              text: (element.innerText ?? element.getAttribute('aria-label') ?? element.getAttribute('name') ?? '').trim().slice(0, 160),
              selector: `${tag}:nth-of-type(${index + 1})`,
            };
          });
        });
        return { ok: true, action: 'inspect_page', url: page.url(), elements };
      }
      case 'click_element': {
        const target = page.locator(action.selector).first();
        const label = ((await target.innerText().catch(() => '')) || (await target.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();
        const forbidden = ['log in', 'login', 'sign in', 'signin', 'checkout', 'pay now', 'buy now', 'delete', 'unsubscribe', 'submit order'];
        if (forbidden.some((word) => label.includes(word))) {
          return { ok: false, action: 'click_element', error: 'clicking authentication, payment or destructive controls is not allowed' };
        }
        await target.click({ timeout: this.limits.actionTimeoutMs });
        await page.waitForLoadState('domcontentloaded', { timeout: this.limits.actionTimeoutMs }).catch(() => undefined);
        return { ok: true, action: 'click_element', url: page.url(), title: await page.title() };
      }
      case 'fill_form': {
        for (const field of action.fields) {
          await page.locator(field.selector).first().fill(field.value, { timeout: this.limits.actionTimeoutMs });
        }
        if (action.submit) {
          const url = page.url().toLowerCase();
          const forbiddenPage = ['login', 'signin', 'auth', 'checkout', 'payment', 'account'];
          if (forbiddenPage.some((word) => url.includes(word))) {
            return { ok: false, action: 'fill_form', error: 'submitting forms on authentication or payment pages is not allowed' };
          }
          await page.keyboard.press('Enter');
          await page.waitForLoadState('domcontentloaded', { timeout: this.limits.actionTimeoutMs }).catch(() => undefined);
        }
        return { ok: true, action: 'fill_form', url: page.url(), title: await page.title() };
      }
      case 'navigate_back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.limits.actionTimeoutMs }).catch(() => null);
        return { ok: true, action: 'navigate_back', url: page.url(), title: await page.title() };
      }
      case 'get_page_title':
        return { ok: true, action: 'get_page_title', url: page.url(), title: await page.title() };
      case 'get_current_url':
        return { ok: true, action: 'get_current_url', url: page.url(), title: await page.title() };
      case 'extract_links': {
        const links = await page.evaluate((limit) => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors.slice(0, limit).map((anchor) => ({
            text: (anchor.textContent ?? '').trim().slice(0, 120),
            href: (anchor as HTMLAnchorElement).href,
          }));
        }, action.limit);
        return { ok: true, action: 'extract_links', url: page.url(), links };
      }
    }
  }

  private async readText(session: SessionState, maxChars: number): Promise<string> {
    const text = await session.page.evaluate(() => {
      const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
      clone?.querySelectorAll('script, style, noscript, iframe, svg').forEach((node) => node.remove());
      return clone?.innerText ?? '';
    });
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
  }
}
