import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Request, Route } from 'playwright';
import { BrowserPool, inspectBrowserPolicy, installInteractionListenerTracking } from '../src/browser.js';
import { isForbiddenClickTarget } from '../src/click-policy.js';

const pools: BrowserPool[] = [];

class FakeDomElement {
  parentElement: FakeDomElement | null = null;
  childNodes: FakeDomElement[] = [];
  labels: FakeDomElement[] = [];
  rootNode: object | null = null;
  shadowRoot: object | null = null;
  assignedSlot: FakeDomElement | null = null;

  get children(): FakeDomElement[] {
    return this.childNodes;
  }

  constructor(
    private readonly attributes: Record<string, string>,
    readonly textContent: string,
    readonly innerText = textContent,
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getRootNode(): object {
    return this.rootNode ?? this.parentElement?.getRootNode() ?? document;
  }

  matches(_selector: string): boolean {
    return false;
  }

  querySelectorAll(selector: string): FakeDomElement[] {
    return this.childNodes.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

class FakeButtonElement extends FakeDomElement {
  readonly type: string;
  readonly disabled = false;
  readonly form: { action: string; method: string; elements: FakeDomElement[] } | null;
  readonly formAction = '';
  readonly formMethod: string;
  readonly name = '';
  readonly value = '';

  constructor(
    attributes: Record<string, string>,
    text: string,
    type = 'button',
    form: { action: string; method: string; elements: FakeDomElement[] } | null = null,
  ) {
    super(attributes, text);
    this.type = type;
    this.form = form;
    this.formMethod = attributes.formmethod ?? '';
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
}

class FakeImageElement extends FakeDomElement {
  constructor(readonly alt: string) {
    super({}, '');
  }

  readonly title = '';
}

class FakeAnchorElement extends FakeDomElement {
  matches(selector: string): boolean {
    return selector.includes('a[href]') && super.getAttribute('href') !== null;
  }
}

class FakeInputElement extends FakeDomElement {
  readonly type: string;
  readonly value: string;
  readonly title = '';
  readonly name: string;
  readonly disabled = false;
  readonly checked = true;
  readonly formAction = '';
  readonly formMethod: string;

  constructor(
    readonly form: { action: string; method: string; elements: FakeDomElement[] } | null = null,
    type = 'text',
    value = '',
    name = '',
    formMethod = '',
  ) {
    super({ type, value, name, ...(formMethod ? { formmethod: formMethod } : {}) }, value);
    this.type = type;
    this.value = value;
    this.name = name;
    this.formMethod = formMethod;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  matches(selector: string): boolean {
    return selector.includes(`input[type="${this.type}"]`);
  }
}
class FakeSelectElement extends FakeDomElement {
  readonly multiple: boolean;
  readonly name: string;
  readonly disabled = false;
  readonly value: string;
  readonly selectedOptions: Array<{ value: string; disabled: boolean }>;

  constructor(name: string, selectedValues: string[], multiple = true) {
    super({ name }, '');
    this.name = name;
    this.multiple = multiple;
    this.value = selectedValues[0] ?? '';
    this.selectedOptions = selectedValues.map((value) => ({ value, disabled: false }));
  }
}
class FakeTextAreaElement extends FakeDomElement {}
class FakeLabelElement extends FakeDomElement {
  readonly control = null;
}
class FakeSlotElement extends FakeDomElement {
  readonly localName = 'slot';
  private assigned: FakeDomElement[] = [];

  assignedElements(): FakeDomElement[] {
    return this.assigned;
  }

  setAssignedElements(elements: FakeDomElement[]): void {
    this.assigned = elements;
  }
}

function stubFakeDom(
  activeElement: FakeDomElement | null,
  image: FakeImageElement,
  trackedListeners = new WeakSet<object>(),
  trackedShadowRoots = new WeakMap<object, object>(),
): void {
  const originalGetAttribute = FakeDomElement.prototype.getAttribute;
  const callOriginalGetAttribute = Function.prototype.call.bind(originalGetAttribute);
  const originalFakeMatches = FakeDomElement.prototype.matches;
  const callOriginalFakeMatches = Function.prototype.call.bind(originalFakeMatches);
  const originalAnchorMatches = FakeAnchorElement.prototype.matches;
  const callOriginalAnchorMatches = Function.prototype.call.bind(originalAnchorMatches);
  const originalMatches = (target: FakeDomElement, selector: string): boolean =>
    target instanceof FakeAnchorElement
      ? callOriginalAnchorMatches(target, selector)
      : callOriginalFakeMatches(target, selector);
  vi.stubGlobal('Element', FakeDomElement);
  vi.stubGlobal('HTMLElement', FakeDomElement);
  vi.stubGlobal('HTMLButtonElement', FakeButtonElement);
  vi.stubGlobal('HTMLInputElement', FakeInputElement);
  vi.stubGlobal('HTMLSelectElement', FakeSelectElement);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
  vi.stubGlobal('HTMLLabelElement', FakeLabelElement);
  vi.stubGlobal('HTMLImageElement', FakeImageElement);
  vi.stubGlobal('document', { activeElement, getElementById: vi.fn(() => image) });
  vi.stubGlobal('window', {
    __agentTasksHasInteractionListener: (target: object) => trackedListeners.has(target),
    __agentTasksGetShadowRoot: (host: object) => trackedShadowRoots.get(host),
    __agentTasksGetAttribute: (target: Element, name: string) => callOriginalGetAttribute(target as unknown as FakeDomElement, name),
    __agentTasksMatchesElement: (target: Element, selector: string) => originalMatches(target as unknown as FakeDomElement, selector),
    __agentTasksGetTextContent: (target: Node) => (target as unknown as FakeDomElement).textContent ?? null,
    __agentTasksGetProperty: (target: object, property: PropertyKey) => Reflect.get(target, property),
    __agentTasksGetComposedParent: (target: Element) => {
      const current = target as unknown as FakeDomElement;
      if (current.assignedSlot) return current.assignedSlot as unknown as Element;
      if (current.parentElement) return current.parentElement as unknown as Element;
      const host = Reflect.get(current.getRootNode(), 'host');
      return host instanceof FakeDomElement ? host as unknown as Element : null;
    },
  });
}

function setupPool(options: {
  label?: string;
  pageUrl?: string;
  href?: string | null;
  formAction?: string | null;
  associatedFormAction?: string | null;
  imageAlt?: string;
  activationTargets?: Array<{
    label: string;
    href?: string | null;
    formAction?: string | null;
    formFields?: Array<{ name: string; value: string }>;
    hasScriptHandlers?: boolean;
  }>;
  formSubmission?: {
    formAction: string;
    method?: string;
    fields?: Array<{ name: string; value: string }>;
    hasScriptHandlers?: boolean;
    submitters: Array<{ label: string; formAction: string }>;
  } | null;
  blockedInteractionCounts?: number[];
  armInteractionSucceeds?: boolean;
} = {}) {
  const click = vi.fn().mockResolvedValue(undefined);
  const locatorClick = vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const attributes: Record<string, string | null> = {
    'aria-label': null,
    value: null,
    title: null,
    name: null,
    type: options.imageAlt ? 'image' : 'submit',
    alt: options.imageAlt ?? null,
    href: options.href ?? null,
  };
  const handle = {
    evaluate: vi.fn().mockImplementation(async (_fn: unknown, argument?: unknown) => {
      if (typeof argument === 'string') return true;
      if (argument && typeof argument === 'object' && 'fingerprint' in argument) {
        return options.armInteractionSucceeds ?? true;
      }
      return {
        kind: 'click',
        pageUrl: options.pageUrl ?? 'https://shop.example/cart',
        targets: (options.activationTargets ?? [{
          label: [options.label ?? 'Continue', options.imageAlt ?? ''].filter(Boolean).join(' '),
          href: options.href ?? null,
          formAction: options.formAction ?? options.associatedFormAction ?? null,
        }]).map((target) => ({ formFields: [], hasScriptHandlers: false, ...target })),
      };
    }),
    click,
    fill,
  };
  const target = {
    first: vi.fn(),
    elementHandle: vi.fn().mockResolvedValue(handle),
    innerText: vi.fn().mockResolvedValue(options.label ?? 'Continue'),
    getAttribute: vi.fn(async (name: string) => attributes[name] ?? null),
    click: locatorClick,
    fill: vi.fn().mockResolvedValue(undefined),
  };
  target.first.mockReturnValue(target);

  const page = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    url: vi.fn(() => options.pageUrl ?? 'https://shop.example/cart'),
    locator: vi.fn(() => target),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Cart'),
    evaluate: vi.fn().mockImplementation(async (_fn: unknown, argument?: unknown) => {
      if (argument === null) {
        return options.formSubmission
          ? {
            kind: 'form',
            pageUrl: options.pageUrl ?? 'https://shop.example/cart',
            method: 'get',
            fields: [],
            hasScriptHandlers: false,
            ...options.formSubmission,
          }
          : null;
      }
      if (typeof argument === 'string') return true;
      if (argument && typeof argument === 'object' && 'fingerprint' in argument) {
        return options.armInteractionSucceeds ?? true;
      }
      const index = countReads++;
      return options.blockedInteractionCounts?.[index] ?? 0;
    }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Page;
  let countReads = 0;
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    version: vi.fn(() => 'test-browser'),
  } as unknown as Browser;

  vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
  const pool = new BrowserPool(
    { maxSessions: 1, sessionTtlMs: 60_000, actionTimeoutMs: 1_000, maxTextChars: 1_000 },
    { allowedPorts: [80, 443], allowHttp: false, chromiumSandbox: false },
  );
  pools.push(pool);
  return pool.start().then(async () => ({ pool, id: await pool.create(), click, fill, locatorClick, target, handle, page, context }));
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BrowserPool click policy wiring', () => {
  it('installs listener tracking before opening a page', async () => {
    const { context } = await setupPool();

    expect(context.addInitScript).toHaveBeenCalledOnce();
    expect(context.addInitScript).toHaveBeenCalledWith(expect.stringContaining('installInteractionListenerTracking'));
  });

  it('blocks sensitive HTTP navigation redirect hops but allows safe and non-navigation redirects', async () => {
    const { context } = await setupPool();
    const routeHandler = vi.mocked(context.route).mock.calls[0]?.[1];
    if (typeof routeHandler !== 'function') throw new Error('expected a route handler');

    const visit = async (options: { url: string; redirectedFrom?: string; navigation?: boolean }) => {
      const abort = vi.fn().mockResolvedValue(undefined);
      const continueRequest = vi.fn().mockResolvedValue(undefined);
      const request = {
        url: () => options.url,
        isNavigationRequest: () => options.navigation ?? true,
        redirectedFrom: () => options.redirectedFrom ? { url: () => options.redirectedFrom } : null,
      } as unknown as Request;
      const route = {
        request: () => request,
        abort,
        continue: continueRequest,
      } as unknown as Route;
      await routeHandler(route, request);
      return { abort, continueRequest };
    };

    const blocked = await visit({
      url: 'https://shop.example/checkout',
      redirectedFrom: 'https://shop.example/continue',
    });
    const safe = await visit({
      url: 'https://shop.example/products',
      redirectedFrom: 'https://shop.example/continue',
    });
    const asset = await visit({
      url: 'https://shop.example/checkout/image.png',
      redirectedFrom: 'https://shop.example/image',
      navigation: false,
    });
    const direct = await visit({ url: 'https://shop.example/checkout' });

    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continueRequest).not.toHaveBeenCalled();
    expect(safe.continueRequest).toHaveBeenCalledOnce();
    expect(safe.abort).not.toHaveBeenCalled();
    expect(asset.continueRequest).toHaveBeenCalledOnce();
    expect(direct.continueRequest).toHaveBeenCalledOnce();
  });

  it('records ordinary interaction listeners before page code runs', () => {
    class FakeEventTarget {
      private readonly listeners = new Map<string, EventListener[]>();

      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        _options?: boolean | AddEventListenerOptions,
      ): void {
        if (!listener) return;
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(typeof listener === 'function' ? listener : (event) => listener.handleEvent(event));
        this.listeners.set(type, handlers);
      }

      dispatch(event: FakeEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
          listener.call(this, event as unknown as Event);
          if (event.stopped) return;
        }
      }
    }
    class FakeEvent {
      defaultPrevented = false;
      stopped = false;

      constructor(readonly type: string, private readonly path: EventTarget[]) {}

      composedPath(): EventTarget[] {
        return this.path;
      }

      preventDefault(): void {
        this.defaultPrevented = true;
      }

      stopImmediatePropagation(): void {
        this.stopped = true;
      }
    }
    class FakeElementHost extends FakeEventTarget {
      constructor(private readonly attributes: Record<string, string> = {}) {
        super();
      }

      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      matches(_selector: string): boolean {
        return false;
      }

      attachShadow(_init: ShadowRootInit): ShadowRoot {
        return { host: this, children: [] } as unknown as ShadowRoot;
      }
    }
    vi.stubGlobal('EventTarget', FakeEventTarget);
    vi.stubGlobal('Event', FakeEvent);
    vi.stubGlobal('Element', FakeElementHost);
    const fakeWindow = new FakeEventTarget();
    const fakeDocument = new FakeEventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);

    installInteractionListenerTracking('test-intent', () => null);
    const clickTarget = new FakeEventTarget();
    const loadTarget = new FakeEventTarget();
    const formDataTarget = new FakeEventTarget();
    const lifecycleTarget = new FakeEventTarget();
    const pageClickHandler = vi.fn();
    const pageBeforeUnloadHandler = vi.fn();
    clickTarget.addEventListener('click', () => undefined);
    loadTarget.addEventListener('load', () => undefined);
    formDataTarget.addEventListener('formdata', () => undefined);
    lifecycleTarget.addEventListener('beforeunload', () => undefined);
    clickTarget.addEventListener('click', pageClickHandler);
    fakeWindow.addEventListener('beforeunload', pageBeforeUnloadHandler);
    const shadowHost = new FakeElementHost();
    const shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

    const hasListener = (window as Window & {
      __agentTasksHasInteractionListener?: (target: EventTarget, type?: string) => boolean;
    }).__agentTasksHasInteractionListener;
    const getShadowRoot = (window as Window & {
      __agentTasksGetShadowRoot?: (host: Element) => ShadowRoot | undefined;
    }).__agentTasksGetShadowRoot;
    const getTrustedAttribute = (window as Window & {
      __agentTasksGetAttribute?: (target: Element, name: string) => string | null;
    }).__agentTasksGetAttribute;
    expect(hasListener).toBeTypeOf('function');
    expect(Reflect.get(hasListener as object, 'add')).toBeUndefined();
    expect(hasListener?.(clickTarget as unknown as EventTarget, 'click')).toBe(true);
    expect(hasListener?.(clickTarget as unknown as EventTarget, 'beforeunload')).toBe(false);
    expect(hasListener?.(formDataTarget as unknown as EventTarget, 'formdata')).toBe(true);
    expect(hasListener?.(lifecycleTarget as unknown as EventTarget, 'beforeunload')).toBe(true);
    expect(hasListener?.(loadTarget as unknown as EventTarget)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(FakeEventTarget.prototype, 'addEventListener'))
      .toMatchObject({ configurable: false, writable: false });
    expect(Object.getOwnPropertyDescriptor(window, '__agentTasksHasInteractionListener'))
      .toMatchObject({ configurable: false, writable: false });
    expect(getShadowRoot?.(shadowHost as unknown as Element)).toBe(shadowRoot);
    const attributeTarget = new FakeElementHost({ href: '/checkout' });
    attributeTarget.getAttribute = () => null;
    FakeElementHost.prototype.getAttribute = () => null;
    expect(getTrustedAttribute?.(attributeTarget as unknown as Element, 'href')).toBe('/checkout');
    expect(Object.getOwnPropertyDescriptor(FakeElementHost.prototype, 'attachShadow'))
      .toMatchObject({ configurable: false, writable: false });

    const clickEvent = new FakeEvent('click', [clickTarget as unknown as EventTarget, fakeDocument as unknown as EventTarget, fakeWindow as unknown as EventTarget]);
    fakeWindow.dispatch(clickEvent);
    const clickDuringUnloadEvent = new FakeEvent('click', [fakeDocument as unknown as EventTarget, fakeWindow as unknown as EventTarget]);
    fakeWindow.dispatch(clickDuringUnloadEvent);
    const lifecycleEvent = new FakeEvent('beforeunload', [fakeWindow as unknown as EventTarget]);
    fakeWindow.dispatch(lifecycleEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(clickEvent.stopped).toBe(true);
    expect(clickDuringUnloadEvent.defaultPrevented).toBe(true);
    expect(clickDuringUnloadEvent.stopped).toBe(true);
    expect(lifecycleEvent.defaultPrevented).toBe(true);
    expect(lifecycleEvent.stopped).toBe(true);
    expect(pageClickHandler).not.toHaveBeenCalled();
    expect(pageBeforeUnloadHandler).not.toHaveBeenCalled();
    const getBlockedCount = (window as Window & {
      __agentTasksGetBlockedInteractionCount?: () => number;
    }).__agentTasksGetBlockedInteractionCount;
    expect(getBlockedCount?.()).toBe(3);

    const originalSetHas = Set.prototype.has;
    const originalWeakMapGet = WeakMap.prototype.get;
    const originalWeakMapSet = WeakMap.prototype.set;
    const tamperedTarget = new FakeEventTarget();
    const tamperedShadowHost = new FakeElementHost();
    let rootAfterTampering: ShadowRoot | undefined;
    let queryAfterTampering = false;
    try {
      Set.prototype.has = () => false;
      WeakMap.prototype.get = () => undefined;
      WeakMap.prototype.set = () => { throw new Error('page tampered with WeakMap.set'); };
      tamperedTarget.addEventListener('click', () => undefined);
      queryAfterTampering = hasListener?.(tamperedTarget as unknown as EventTarget) ?? false;
      tamperedShadowHost.attachShadow({ mode: 'closed' });
      rootAfterTampering = getShadowRoot?.(tamperedShadowHost as unknown as Element);
    } finally {
      Set.prototype.has = originalSetHas;
      WeakMap.prototype.get = originalWeakMapGet;
      WeakMap.prototype.set = originalWeakMapSet;
    }
    expect(queryAfterTampering).toBe(true);
    expect(rootAfterTampering).toBeDefined();
  });

  it('blocks click and form submission when their live intent changes after arming', () => {
    class FakeTarget {
      private readonly listeners = new Map<string, EventListener[]>();

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(typeof listener === 'function' ? listener : (event) => listener.handleEvent(event));
        this.listeners.set(type, handlers);
      }

      dispatch(event: FakePolicyEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
          listener.call(this, event as unknown as Event);
          if (event.stopped) return;
        }
      }
    }
    class FakePolicyEvent {
      defaultPrevented = false;
      stopped = false;
      constructor(
        readonly type: string,
        private readonly path: EventTarget[],
        readonly isTrusted = true,
        readonly key?: string,
        readonly submitter?: Element | null,
      ) {}

      composedPath(): EventTarget[] {
        return this.path;
      }

      preventDefault(): void {
        this.defaultPrevented = true;
      }

      stopImmediatePropagation(): void {
        this.stopped = true;
      }
    }
    class FakeElement extends FakeTarget {
      form: FakeElement | null = null;

      getAttribute(_name: string): string | null {
        return null;
      }

      matches(_selector: string): boolean {
        return false;
      }

      closest(selector: string): FakeElement | null {
        return selector === 'form' ? this.form : null;
      }

      attachShadow(): ShadowRoot {
        return { host: this } as unknown as ShadowRoot;
      }
    }
    class FakeInput extends FakeElement {}
    class FakeSelect extends FakeElement {}
    class FakeTextArea extends FakeElement {}
    class FakeButton extends FakeElement {
      readonly type = 'submit';
    }
    const fakeWindow = new FakeTarget();
    const fakeDocument = Object.assign(new FakeTarget(), { activeElement: null as FakeElement | null });
    vi.stubGlobal('EventTarget', FakeTarget);
    vi.stubGlobal('Event', FakePolicyEvent);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('HTMLButtonElement', FakeButton);
    vi.stubGlobal('HTMLSelectElement', FakeSelect);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);

    let clickIntent: { href: string } = { href: '/products' };
    let formIntent: { action: string } = { action: '/contact' };
    installInteractionListenerTracking('private-token', (element) => element ? clickIntent : formIntent);
    const clickTarget = new FakeElement();
    const form = new FakeElement();
    const activeField = new FakeElement();
    activeField.form = form;
    fakeDocument.activeElement = activeField;

    const arm = (window as Window & {
      __agentTasksArmInteraction?: (target: Element | null, token: string, fingerprint: string) => boolean;
    }).__agentTasksArmInteraction;
    const clickArmed = arm?.(clickTarget as unknown as Element, 'private-token', JSON.stringify(clickIntent));
    clickIntent = { href: '/checkout' };
    const clickEvent = new FakePolicyEvent('click', [
      clickTarget as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ]);
    fakeWindow.dispatch(clickEvent);

    const formArmed = arm?.(null, 'private-token', JSON.stringify(formIntent));
    const enterEvent = new FakePolicyEvent('keydown', [
      activeField as unknown as EventTarget,
      form as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ], true, 'Enter');
    fakeWindow.dispatch(enterEvent);
    formIntent = { action: '/account/delete' };
    const submitEvent = new FakePolicyEvent('submit', [
      form as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ]);
    fakeWindow.dispatch(submitEvent);

    const unarmedScriptEvent = new FakePolicyEvent('click', [
      new FakeElement() as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ], false);
    fakeWindow.dispatch(unarmedScriptEvent);

    clickIntent = { href: '/products' };
    const safeSubmitForm = new FakeElement();
    const safeSubmitter = new FakeButton();
    safeSubmitter.form = safeSubmitForm;
    const otherSubmitter = new FakeButton();
    otherSubmitter.form = safeSubmitForm;
    const submitterArmed = arm?.(
      safeSubmitter as unknown as Element,
      'private-token',
      JSON.stringify(clickIntent),
    );
    const submitterClick = new FakePolicyEvent('click', [
      safeSubmitter as unknown as EventTarget,
      safeSubmitForm as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ]);
    fakeWindow.dispatch(submitterClick);
    const unrelatedSubmit = new FakePolicyEvent('submit', [
      safeSubmitForm as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ], true, undefined, otherSubmitter as unknown as Element);
    fakeWindow.dispatch(unrelatedSubmit);
    arm?.(safeSubmitter as unknown as Element, 'private-token', JSON.stringify(clickIntent));
    fakeWindow.dispatch(submitterClick);
    const authorizedSubmit = new FakePolicyEvent('submit', [
      safeSubmitForm as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ], true, undefined, safeSubmitter as unknown as Element);
    fakeWindow.dispatch(authorizedSubmit);
    const reusedSubmit = new FakePolicyEvent('submit', [
      safeSubmitForm as unknown as EventTarget,
      fakeDocument as unknown as EventTarget,
      fakeWindow as unknown as EventTarget,
    ], true, undefined, safeSubmitter as unknown as Element);
    fakeWindow.dispatch(reusedSubmit);

    expect(clickArmed).toBe(true);
    expect(formArmed).toBe(true);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(clickEvent.stopped).toBe(true);
    expect(submitEvent.stopped).toBe(true);
    expect(unarmedScriptEvent.defaultPrevented).toBe(true);
    expect(submitterArmed).toBe(true);
    expect(submitterClick.defaultPrevented).toBe(false);
    expect(unrelatedSubmit.defaultPrevented).toBe(true);
    expect(authorizedSubmit.defaultPrevented).toBe(false);
    expect(reusedSubmit.defaultPrevented).toBe(true);
  });

  it('marks registered click handlers as unverified script behavior', () => {
    const image = new FakeImageElement('');
    const button = new FakeButtonElement({}, 'Continue');
    const trackedListeners = new WeakSet<object>([button]);
    stubFakeDom(null, image, trackedListeners);

    const inspection = inspectBrowserPolicy(button as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it.each(['shadow root', 'shadow host'])('checks handlers in the composed path through a %s', (listenerLocation) => {
    const image = new FakeImageElement('');
    const host = new FakeDomElement({}, 'host');
    const shadowRoot = { host };
    const button = new FakeButtonElement({}, 'Continue');
    button.rootNode = shadowRoot;
    const listenerTarget = listenerLocation === 'shadow root' ? shadowRoot : host;
    const trackedListeners = new WeakSet<object>([listenerTarget]);
    stubFakeDom(null, image, trackedListeners);

    const inspection = inspectBrowserPolicy(button as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('detects a listener on a plain descendant of the selected click target', () => {
    const image = new FakeImageElement('');
    const container = new FakeDomElement({}, 'Container');
    const child = new FakeDomElement({}, 'Continue');
    child.parentElement = container;
    container.childNodes = [child];
    stubFakeDom(null, image, new WeakSet<object>([child]));

    const inspection = inspectBrowserPolicy(container as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('detects a listener on a plain descendant inside a closed shadow root', () => {
    const image = new FakeImageElement('');
    const container = new FakeDomElement({}, 'Container');
    const host = new FakeDomElement({}, 'Widget');
    const shadowChild = new FakeDomElement({}, 'Continue');
    const shadowRoot = { children: [shadowChild] };
    host.parentElement = container;
    container.childNodes = [host];
    shadowChild.rootNode = shadowRoot;
    host.shadowRoot = null;
    stubFakeDom(
      null,
      image,
      new WeakSet<object>([shadowChild]),
      new WeakMap<object, object>([[host, shadowRoot]]),
    );

    const inspection = inspectBrowserPolicy(container as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('collects native actionable controls inside a closed shadow root', () => {
    const image = new FakeImageElement('');
    const host = new FakeDomElement({}, 'Widget');
    const shadowLink = new FakeAnchorElement({ href: '/checkout' }, 'Continue');
    const shadowRoot = { host, children: [shadowLink] };
    shadowLink.rootNode = shadowRoot;
    shadowLink.getAttribute = () => null;
    shadowLink.matches = () => false;
    host.shadowRoot = null;
    stubFakeDom(null, image, new WeakSet<object>(), new WeakMap<object, object>([[host, shadowRoot]]));

    const inspection = inspectBrowserPolicy(host as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets).toContainEqual(expect.objectContaining({ label: 'Continue Continue', href: '/checkout' }));
    const shadowLinkPolicy = inspection.targets.find(({ href }) => href === '/checkout');
    expect(shadowLinkPolicy).toBeDefined();
    expect(isForbiddenClickTarget(shadowLinkPolicy?.label ?? '', {
      href: shadowLinkPolicy?.href,
      pageUrl: 'https://shop.example/cart',
    })).toBe(true);
  });

  it('inspects sensitive actionable ancestors across assigned slots and shadow hosts', () => {
    const image = new FakeImageElement('');
    const shadowHost = new FakeDomElement({}, 'Widget');
    const shadowRoot = { host: shadowHost };
    const anchor = new FakeAnchorElement({ href: '/checkout' }, 'Continue');
    const slot = new FakeSlotElement({}, 'slot');
    const selected = new FakeDomElement({}, 'Continue');
    anchor.rootNode = shadowRoot;
    slot.parentElement = anchor;
    selected.assignedSlot = slot;
    slot.setAssignedElements([selected]);
    stubFakeDom(null, image, new WeakSet<object>(), new WeakMap<object, object>([[shadowHost, shadowRoot]]));

    const inspection = inspectBrowserPolicy(selected as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    const ancestor = inspection.targets.find(({ href }) => href === '/checkout');
    expect(ancestor).toBeDefined();
    expect(isForbiddenClickTarget(ancestor?.label ?? '', {
      href: ancestor?.href,
      pageUrl: 'https://shop.example/cart',
    })).toBe(true);
  });

  it('detects handlers on elements assigned to a slot in the composed subtree', () => {
    const image = new FakeImageElement('');
    const slot = new FakeSlotElement({}, 'slot');
    const assigned = new FakeDomElement({}, 'Continue');
    assigned.assignedSlot = slot;
    slot.setAssignedElements([assigned]);
    stubFakeDom(null, image, new WeakSet<object>([assigned]));

    const inspection = inspectBrowserPolicy(slot as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('marks inline event-handler attributes as unverified script behavior', () => {
    const image = new FakeImageElement('');
    const button = new FakeButtonElement({ onclick: 'submitPayment()' }, 'Continue');
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(button as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('fails closed if listener tracking is unavailable', () => {
    const image = new FakeImageElement('');
    const button = new FakeButtonElement({}, 'Continue');
    stubFakeDom(null, image);
    vi.stubGlobal('window', {});

    const inspection = inspectBrowserPolicy(button as unknown as Element);

    expect(inspection).toBeNull();
  });

  it('marks a form with registered submitter handlers as unverified', () => {
    const image = new FakeImageElement('');
    const trackedSubmitter = new FakeButtonElement({}, 'Continue', 'submit');
    const form = { action: 'https://shop.example/submit', method: 'post', elements: [trackedSubmitter] };
    const trackedListeners = new WeakSet<object>([trackedSubmitter]);
    stubFakeDom(new FakeInputElement(form), image, trackedListeners);

    const inspection = inspectBrowserPolicy(null);

    expect(inspection?.kind).toBe('form');
    if (inspection?.kind !== 'form') throw new Error('expected form inspection');
    expect(inspection.hasScriptHandlers).toBe(true);
    expect(inspection.submitters[0]?.hasScriptHandlers).toBe(true);
  });

  it('checks associated form handlers when a submitter is outside the form tree', () => {
    const image = new FakeImageElement('');
    const form = { action: 'https://shop.example/submit', method: 'post', elements: [] as FakeDomElement[] };
    const submitter = new FakeButtonElement({}, 'Continue', 'submit', form);
    form.elements = [submitter];
    const trackedListeners = new WeakSet<object>([form]);
    stubFakeDom(null, image, trackedListeners);

    const inspection = inspectBrowserPolicy(submitter as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.hasScriptHandlers).toBe(true);
  });

  it('resolves image alt text referenced by aria-labelledby', () => {
    const image = new FakeImageElement('Delete account');
    const button = new FakeButtonElement({ 'aria-labelledby': 'delete-icon' }, 'Continue');
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(button as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.label).toContain('Delete account');
    expect(isForbiddenClickTarget(inspection.targets[0]?.label ?? '')).toBe(true);
  });

  it('resolves image alt text for a labelled form submitter', () => {
    const image = new FakeImageElement('Delete account');
    const submitter = new FakeButtonElement({ 'aria-labelledby': 'delete-icon' }, 'Continue', 'submit');
    const form = { action: 'https://shop.example/submit', method: 'post', elements: [submitter] };
    stubFakeDom(new FakeInputElement(form), image);

    const inspection = inspectBrowserPolicy(null);

    expect(inspection?.kind).toBe('form');
    if (inspection?.kind !== 'form') throw new Error('expected form inspection');
    expect(inspection.submitters[0]?.label).toContain('Delete account');
    expect(isForbiddenClickTarget(inspection.submitters[0]?.label ?? '')).toBe(true);
  });

  it('discovers a sensitive interactive descendant inside the selected element', () => {
    const image = new FakeImageElement('');
    const wrapper = new FakeDomElement({}, 'Continue');
    wrapper.childNodes = [new FakeAnchorElement({ href: '/checkout' }, 'Continue')];
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(wrapper as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets.some(({ href }) => href === '/checkout')).toBe(true);
    expect(inspection.targets.some(({ href, label }) =>
      isForbiddenClickTarget(label, { href, pageUrl: 'https://shop.example/cart' }))).toBe(true);
  });

  it('discovers a destructive input button inside the selected element', () => {
    const image = new FakeImageElement('');
    const wrapper = new FakeDomElement({}, 'Continue');
    wrapper.childNodes = [new FakeInputElement(null, 'button', 'Delete account')];
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(wrapper as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets.some(({ label }) => isForbiddenClickTarget(label))).toBe(true);
  });

  it('discovers a sensitive interactive ancestor around the selected element', () => {
    const image = new FakeImageElement('');
    const link = new FakeAnchorElement({ href: '/checkout' }, 'Continue');
    const child = new FakeDomElement({}, 'Continue');
    child.parentElement = link;
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(child as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets.some(({ href, label }) =>
      isForbiddenClickTarget(label, { href, pageUrl: 'https://shop.example/cart' }))).toBe(true);
  });

  it('resolves native associated label text for a submit control', () => {
    const image = new FakeImageElement('');
    const submitter = new FakeButtonElement({}, 'Continue', 'submit');
    submitter.labels.push(new FakeLabelElement({}, 'Delete account'));
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(submitter as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.label).toContain('Delete account');
    expect(isForbiddenClickTarget(inspection.targets[0]?.label ?? '')).toBe(true);
  });

  it('collects hidden action fields for the form submission policy', () => {
    const image = new FakeImageElement('');
    const hiddenAction = new FakeInputElement(null, 'hidden', 'delete_account', 'action');
    const form = {
      action: 'https://shop.example/api/submit',
      method: 'get',
      elements: [hiddenAction],
    };
    stubFakeDom(new FakeInputElement(form), image);

    const inspection = inspectBrowserPolicy(null);

    expect(inspection?.kind).toBe('form');
    if (inspection?.kind !== 'form') throw new Error('expected form inspection');
    expect(inspection.fields).toContainEqual({ name: 'action', value: 'delete_account' });
  });

  it('collects POST form intent fields named op', () => {
    const image = new FakeImageElement('');
    const operation = new FakeInputElement(null, 'text', 'delete_account', 'op');
    const form = {
      action: 'https://shop.example/api/submit',
      method: 'post',
      elements: [operation],
    };
    stubFakeDom(new FakeInputElement(form), image);

    const inspection = inspectBrowserPolicy(null);

    expect(inspection?.kind).toBe('form');
    if (inspection?.kind !== 'form') throw new Error('expected form inspection');
    expect(inspection.fields).toContainEqual({ name: 'op', value: 'delete_account' });
  });

  it('collects form intent fields when inspecting a submit button click', () => {
    const image = new FakeImageElement('');
    const hiddenAction = new FakeInputElement(null, 'hidden', 'delete_account', 'action');
    const form: { action: string; method: string; elements: FakeDomElement[] } = {
      action: 'https://shop.example/api/submit',
      method: 'post',
      elements: [],
    };
    const submitter = new FakeButtonElement({}, 'Continue', 'submit', form);
    form.elements = [hiddenAction, submitter];
    stubFakeDom(null, image);

    const inspection = inspectBrowserPolicy(submitter as unknown as Element);

    expect(inspection?.kind).toBe('click');
    if (inspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(inspection.targets[0]?.formFields).toContainEqual({ name: 'action', value: 'delete_account' });
  });

  it('uses a submitter formmethod=get override to inspect all effective click fields', () => {
    const image = new FakeImageElement('');
    const form: { action: string; method: string; elements: FakeDomElement[] } = {
      action: 'https://shop.example/api/submit',
      method: 'post',
      elements: [],
    };
    const operation = new FakeInputElement(null, 'text', 'delete_account', 'op');
    const submitter = new FakeButtonElement({ formmethod: 'get' }, 'Continue', 'submit', form);
    form.elements = [operation, submitter];
    stubFakeDom(new FakeInputElement(form), image);

    const clickInspection = inspectBrowserPolicy(submitter as unknown as Element);
    const enterInspection = inspectBrowserPolicy(null);

    expect(clickInspection?.kind).toBe('click');
    if (clickInspection?.kind !== 'click') throw new Error('expected click inspection');
    expect(clickInspection.targets[0]?.formFields).toContainEqual({ name: 'op', value: 'delete_account' });
    expect(enterInspection?.kind).toBe('form');
    if (enterInspection?.kind !== 'form') throw new Error('expected form inspection');
    expect(enterInspection.fields).toContainEqual({ name: 'op', value: 'delete_account' });
  });

  it('collects every selected value from multiple-select form fields', () => {
    const image = new FakeImageElement('');
    const inspectFields = (method: string, name: string) => {
      const selectedActions = new FakeSelectElement(name, ['save', 'delete_account']);
      const form = {
        action: 'https://shop.example/api/submit',
        method,
        elements: [selectedActions],
      };
      stubFakeDom(new FakeInputElement(form), image);
      const inspection = inspectBrowserPolicy(null);
      if (inspection?.kind !== 'form') throw new Error('expected form inspection');
      return inspection.fields;
    };

    expect(inspectFields('get', 'op')).toEqual([
      { name: 'op', value: 'save' },
      { name: 'op', value: 'delete_account' },
    ]);
    expect(inspectFields('post', 'action')).toEqual([
      { name: 'action', value: 'save' },
      { name: 'action', value: 'delete_account' },
    ]);
  });

  it('blocks an associated form action with a sensitive query route when no formaction override exists', async () => {
    const { pool, id, click, handle } = await setupPool({
      associatedFormAction: 'https://shop.example/submit?mode=checkout',
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(handle.evaluate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('allows a harmless button on the cart page', async () => {
    const { pool, id, click } = await setupPool({ href: '/products' });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: true, action: 'click_element' });
    expect(click).toHaveBeenCalledOnce();
  });

  it('blocks subscription initiation controls', async () => {
    const { pool, id, click } = await setupPool({ label: 'Subscribe' });

    const result = await pool.act(id, { action: 'click_element', selector: '#subscribe' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks common subscription wording variations', async () => {
    const { pool, id, click } = await setupPool({ label: 'Start your subscription' });

    const result = await pool.act(id, { action: 'click_element', selector: '#subscribe' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['Log out', 'Logout', 'Sign out'])('blocks sign-out control %j', async (label) => {
    const { pool, id, click } = await setupPool({ label });

    const result = await pool.act(id, { action: 'click_element', selector: '#logout' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks a bland click targeting the logout route', async () => {
    const { pool, id, click } = await setupPool({ formAction: 'https://shop.example/logout' });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks a JavaScript URL before clicking it', async () => {
    const { pool, id, click } = await setupPool({
      href: 'javascript:document.forms[0].submit()',
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks an HTTP redirect link whose target uses a JavaScript URL', async () => {
    const { pool, id, click } = await setupPool({
      href: 'https://shop.example/redirect?next=javascript%3Adocument.forms%5B0%5D.submit%28%29',
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks a bland click control with registered script listeners', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{ label: 'Continue', hasScriptHandlers: true }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('inspects and clicks the same resolved element handle', async () => {
    const { pool, id, target, handle, click, locatorClick } = await setupPool({ href: '/products' });

    const result = await pool.act(id, { action: 'click_element', selector: '.changing-match' });

    expect(result).toMatchObject({ ok: true, action: 'click_element' });
    expect(target.elementHandle).toHaveBeenCalledOnce();
    expect(handle.evaluate).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalledOnce();
    expect(locatorClick).not.toHaveBeenCalled();
  });

  it('reports a handler that appears after preflight when dispatch blocks it', async () => {
    const { pool, id, click } = await setupPool({
      href: '/products',
      blockedInteractionCounts: [0, 1],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '.changing-match' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).toHaveBeenCalledOnce();
  });

  it('refuses a click when live intent no longer matches its preflight fingerprint', async () => {
    const { pool, id, click } = await setupPool({
      href: '/products',
      armInteractionSucceeds: false,
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks filling a field with registered input handlers before mutation', async () => {
    const { pool, id, fill } = await setupPool({
      activationTargets: [{ label: 'Message', hasScriptHandlers: true }],
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(fill).not.toHaveBeenCalled();
  });

  it('reports an input handler that appears after field preflight', async () => {
    const { pool, id, fill } = await setupPool({
      blockedInteractionCounts: [0, 1],
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(fill).toHaveBeenCalledOnce();
  });

  it.each(['Abo starten', 'Abonnement abschließen'])('blocks German subscription control %j', async (label) => {
    const { pool, id, click } = await setupPool({ label });

    const result = await pool.act(id, { action: 'click_element', selector: '#subscribe' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks an image submit control with a destructive accessible name', async () => {
    const { pool, id, click } = await setupPool({ imageAlt: 'Delete account', label: '' });

    const result = await pool.act(id, { action: 'click_element', selector: 'input[type=image]' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('checks the enclosing link when the selected node is nested inside it', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [
        { label: 'Continue' },
        { label: 'Continue', href: '/checkout' },
      ],
    });

    const result = await pool.act(id, { action: 'click_element', selector: 'a .label' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('checks text referenced by aria-labelledby', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{ label: 'Continue Pay now' }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#submit' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('checks the associated label for a submit control', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{ label: 'Continue' }, { label: 'Delete account' }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#delete' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when the focused form action is sensitive', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/contact',
      formSubmission: { formAction: 'https://shop.example/checkout', submitters: [] },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#email', value: 'reader@example.com' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('reports a submit handler that appears after form preflight', async () => {
    const { pool, id, fill, page } = await setupPool({
      blockedInteractionCounts: [0, 0, 0, 1],
      formSubmission: {
        formAction: 'https://shop.example/contact',
        method: 'post',
        fields: [{ name: 'message', value: 'Hello' }],
        submitters: [{ label: 'Send', formAction: 'https://shop.example/contact' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Hello' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(fill).toHaveBeenCalledOnce();
    expect(page.keyboard.press).toHaveBeenCalledOnce();
  });

  it('refuses Enter submission when live form intent no longer matches preflight', async () => {
    const { pool, id, page } = await setupPool({
      armInteractionSucceeds: false,
      formSubmission: {
        formAction: 'https://shop.example/contact',
        method: 'post',
        fields: [{ name: 'message', value: 'Hello' }],
        submitters: [{ label: 'Send', formAction: 'https://shop.example/contact' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Hello' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks a native checkout link discovered inside a shadow root', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [
        { label: 'Continue', href: '/products' },
        { label: 'Continue', href: '/checkout' },
      ],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#widget' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks Enter submission to the logout route', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/settings',
      formSubmission: {
        formAction: 'https://shop.example/logout',
        method: 'post',
        fields: [],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/logout' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#confirm', value: 'yes' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when the form uses registered script listeners', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/contact',
      formSubmission: {
        formAction: 'https://shop.example/submit',
        method: 'post',
        fields: [],
        hasScriptHandlers: true,
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Hello' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when a hidden GET field carries destructive intent', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/help',
      formSubmission: {
        formAction: 'https://shop.example/api/submit',
        method: 'get',
        fields: [{ name: 'action', value: 'delete_account' }],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/api/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when a POST op field carries destructive intent', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/help',
      formSubmission: {
        formAction: 'https://shop.example/api/submit',
        method: 'post',
        fields: [{ name: 'op', value: 'delete_account' }],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/api/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks clicking a bland submitter when a hidden field carries destructive intent', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{
        label: 'Continue',
        formAction: 'https://shop.example/api/submit',
        formFields: [{ name: 'action', value: 'delete_account' }],
      }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks clicking a bland submitter when a POST op field carries destructive intent', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{
        label: 'Continue',
        formAction: 'https://shop.example/api/submit',
        formFields: [{ name: 'op', value: 'delete_account' }],
      }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks clicking a GET-override submitter with destructive form data', async () => {
    const { pool, id, click } = await setupPool({
      activationTargets: [{
        label: 'Continue',
        formAction: 'https://shop.example/api/submit',
        formFields: [{ name: 'op', value: 'delete_account' }],
      }],
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks clicking a bland submitter on a German cancellation route', async () => {
    const { pool, id, click } = await setupPool({
      formAction: 'https://shop.example/api/vertrag-kuendigen',
    });

    const result = await pool.act(id, { action: 'click_element', selector: '#continue' });

    expect(result).toMatchObject({ ok: false, action: 'click_element' });
    expect(click).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when a GET override serializes destructive form data', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/help',
      formSubmission: {
        formAction: 'https://shop.example/api/submit',
        method: 'get',
        fields: [{ name: 'op', value: 'delete_account' }],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/api/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission to a German cancellation route', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/plans',
      formSubmission: {
        formAction: 'https://shop.example/api/submit?action=kuendigen',
        method: 'post',
        fields: [],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/api/submit?action=kuendigen' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Bitte bearbeiten' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when a multiple select includes destructive action data', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/help',
      formSubmission: {
        formAction: 'https://shop.example/api/submit',
        method: 'post',
        fields: [
          { name: 'action', value: 'save' },
          { name: 'action', value: 'delete_account' },
        ],
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/api/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#message', value: 'Please help' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('allows a GET search form whose query contains sensitive words', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/search',
      formSubmission: {
        formAction: 'https://shop.example/search',
        method: 'get',
        fields: [{ name: 'q', value: 'delete account' }],
        submitters: [{ label: 'Search', formAction: 'https://shop.example/search' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#q', value: 'delete account' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: true, action: 'fill_form' });
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  it('blocks Enter submission when the submitter formaction is sensitive', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/contact',
      formSubmission: {
        formAction: 'https://shop.example/submit',
        submitters: [{ label: 'Continue', formAction: 'https://shop.example/checkout' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#email', value: 'reader@example.com' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission to a subscription endpoint', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/plans',
      formSubmission: { formAction: 'https://shop.example/api/subscribe', submitters: [] },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#email', value: 'reader@example.com' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission with a German subscription submitter', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/plans',
      formSubmission: {
        formAction: 'https://shop.example/submit',
        submitters: [{ label: 'Abonnement abschließen', formAction: 'https://shop.example/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#email', value: 'reader@example.com' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('blocks Enter submission when the form submitter has a sensitive label', async () => {
    const { pool, id, page } = await setupPool({
      pageUrl: 'https://shop.example/profile',
      formSubmission: {
        formAction: 'https://shop.example/submit',
        submitters: [{ label: 'Delete account', formAction: 'https://shop.example/submit' }],
      },
    });

    const result = await pool.act(id, {
      action: 'fill_form',
      fields: [{ selector: '#name', value: 'Reader' }],
      submit: true,
    });

    expect(result).toMatchObject({ ok: false, action: 'fill_form' });
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });
});
