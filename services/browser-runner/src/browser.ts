import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { browserActionSchema } from '@agent-tasks/browser-tools';
import type { BrowserAction, BrowserResult } from '@agent-tasks/browser-tools';
import { checkUrl } from '@agent-tasks/shared';
import type { EgressProxy } from './proxy.js';
import { startEgressProxy } from './proxy.js';
import { isForbiddenClickTarget, isForbiddenFormUrl } from './click-policy.js';

export interface RunnerLimits {
  maxSessions: number;
  sessionTtlMs: number;
  actionTimeoutMs: number;
  maxTextChars: number;
}

type BrowserPolicyInspection =
  | {
      kind: 'click';
      pageUrl: string;
      targets: Array<{
        label: string;
        href: string | null;
        formAction: string | null;
        formFields: Array<{ name: string; value: string }>;
        hasScriptHandlers: boolean;
      }>;
    }
  | {
      kind: 'form';
      pageUrl: string;
      formAction: string;
      method: string;
      fields: Array<{ name: string; value: string }>;
      hasScriptHandlers: boolean;
      submitters: Array<{ label: string; formAction: string; hasScriptHandlers: boolean }>;
    }
  | null;

/** Runs before site scripts and records event listeners that make click intent opaque. */
export function installInteractionListenerTracking(
  intentToken: string,
  policyInspector: (element: Element | null) => unknown,
): void {
  const eventTypes = [
    'auxclick', 'blur', 'change', 'click', 'contextmenu', 'dblclick', 'focus', 'focusin', 'focusout', 'formdata',
    'input', 'keydown', 'keypress', 'keyup', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove',
    'mouseout', 'mouseover', 'mouseup', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove',
    'pointerout', 'pointerover', 'pointerup', 'submit', 'touchcancel', 'touchend', 'touchmove', 'touchstart',
    'beforeunload', 'hashchange', 'pagehide', 'pageshow', 'popstate', 'unload', 'visibilitychange',
  ];
  const interactionEvents = new Set(eventTypes);
  const isInteractionEvent = Set.prototype.has.bind(interactionEvents);
  const listeners = new WeakMap<EventTarget, {
    addType: (type: string) => void;
    hasType: (type?: string) => boolean;
  }>();
  const getListenerTypes = WeakMap.prototype.get.bind(listeners);
  const setListenerTypes = WeakMap.prototype.set.bind(listeners);
  const trackListener = (target: EventTarget, type: string): void => {
    let registry = getListenerTypes(target);
    if (!registry) {
      const types = new Set<string>();
      const addType = Set.prototype.add.bind(types);
      const containsType = Set.prototype.has.bind(types);
      let hasAny = false;
      registry = {
        addType: (eventType: string) => {
          addType(eventType.toLowerCase());
          hasAny = true;
        },
        hasType: (eventType?: string) => eventType === undefined
          ? hasAny
          : containsType(eventType.toLowerCase()),
      };
      setListenerTypes(target, registry);
    }
    registry.addType(type);
  };
  const shadowRoots = new WeakMap<Element, ShadowRoot>();
  const trackShadowRoot = WeakMap.prototype.set.bind(shadowRoots);
  const getShadowRoot = WeakMap.prototype.get.bind(shadowRoots);
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalAttachShadow = Element.prototype.attachShadow;
  const originalGetAttribute = Element.prototype.getAttribute;
  const originalMatches = Element.prototype.matches;
  const callOriginalAddEventListener = Function.prototype.call.bind(originalAddEventListener);
  const callOriginalAttachShadow = Function.prototype.call.bind(originalAttachShadow);
  const callOriginalGetAttribute = Function.prototype.call.bind(originalGetAttribute);
  const callOriginalMatches = Function.prototype.call.bind(originalMatches);
  const nativeTextContentGetter = typeof Node === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.get;
  const callNativeTextContentGetter = nativeTextContentGetter
    ? Function.prototype.call.bind(nativeTextContentGetter)
    : null;
  const callComposedPath = Function.prototype.call.bind(Event.prototype.composedPath);
  const callPreventDefault = Function.prototype.call.bind(Event.prototype.preventDefault);
  const callStopImmediatePropagation = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  const stringify = JSON.stringify.bind(JSON);
  const armedIntents = new WeakMap<EventTarget, {
    fingerprint: string;
    inspectElement: Element | null;
    submitter: Element | null;
    activationSeen: boolean;
  }>();
  const getArmedIntent = WeakMap.prototype.get.bind(armedIntents);
  const setArmedIntent = WeakMap.prototype.set.bind(armedIntents);
  const deleteArmedIntent = WeakMap.prototype.delete.bind(armedIntents);
  const getTrustedAttribute = (element: Element, name: string): string | null =>
    callOriginalGetAttribute(element, name) as string | null;
  const trustedMatches = (element: Element, selector: string): boolean =>
    callOriginalMatches(element, selector) as boolean;
  const getTrustedTextContent = (node: Node): string | null => callNativeTextContentGetter
    ? callNativeTextContentGetter(node) as string | null
    : node.textContent;
  const formForActiveElement = (active: Element | null): HTMLFormElement | null => {
    if (!active) return null;
    if (active instanceof HTMLInputElement
      || active instanceof HTMLButtonElement
      || active instanceof HTMLSelectElement
      || active instanceof HTMLTextAreaElement) return active.form;
    return active.closest('form');
  };
  const armInteraction = (
    element: Element | null,
    token: string,
    expectedFingerprint: string,
  ): boolean => {
    if (token !== intentToken) return false;
    const form = formForActiveElement(document.activeElement);
    const actionTarget: EventTarget | null = element ?? form;
    if (!actionTarget) return false;
    let fingerprint: string | undefined;
    try {
      fingerprint = stringify(policyInspector(element));
    } catch {
      return false;
    }
    if (fingerprint !== expectedFingerprint) return false;
    const isFormControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement;
    const formOwner = isFormControl ? element.form : null;
    const isSubmitter = element instanceof HTMLButtonElement && element.type === 'submit'
      || element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image');
    const state = { fingerprint, inspectElement: element, submitter: isSubmitter ? element : null, activationSeen: false };
    setArmedIntent(actionTarget, state);
    if (isSubmitter && formOwner) {
      setArmedIntent(formOwner, state);
    }
    return true;
  };
  const clearInteraction = (element: Element | null, token: string): boolean => {
    if (token !== intentToken) return false;
    const activeForm = element ? null : formForActiveElement(document.activeElement);
    const target = element ?? activeForm;
    if (!target) return false;
    deleteArmedIntent(target);
    const formOwner = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? element.form
      : null;
    if (formOwner) {
      deleteArmedIntent(formOwner);
    }
    return true;
  };
  const hasListener = (target: EventTarget, type?: string): boolean =>
    getListenerTypes(target)?.hasType(type) ?? false;
  const lifecycleEvents = ['beforeunload', 'hashchange', 'pagehide', 'pageshow', 'popstate', 'unload', 'visibilitychange'];
  const isLifecycleEvent = new Set(lifecycleEvents);
  const isLifecycleInteraction = Set.prototype.has.bind(isLifecycleEvent);
  let blockedInteractionCount = 0;
  const getProperty = Reflect.get.bind(Reflect);
  type NativeGetter = (target: object) => unknown;
  const captureGetter = (prototype: object | undefined, property: string): NativeGetter | null => {
    let current = prototype ?? null;
    while (current) {
      const getter = Object.getOwnPropertyDescriptor(current, property)?.get;
      if (getter) return Function.prototype.call.bind(getter) as NativeGetter;
      current = Object.getPrototypeOf(current) as object | null;
    }
    return null;
  };
  const readParentElement = captureGetter(typeof Node === 'undefined' ? undefined : Node.prototype, 'parentElement');
  const readAssignedSlot = captureGetter(Element.prototype, 'assignedSlot');
  const readShadowHost = captureGetter(typeof ShadowRoot === 'undefined' ? undefined : ShadowRoot.prototype, 'host');
  const callGetRootNode = typeof Node === 'undefined'
    ? null
    : Function.prototype.call.bind(Node.prototype.getRootNode) as (target: Node) => Node;
  const getComposedParent = (current: Element): Element | null => {
    const assignedSlot = readAssignedSlot
      ? readAssignedSlot(current) as Element | null
      : current.assignedSlot;
    if (assignedSlot) return assignedSlot;
    const parent = readParentElement
      ? readParentElement(current) as Element | null
      : current.parentElement;
    if (parent) return parent;
    const root = callGetRootNode ? callGetRootNode(current) : current.getRootNode();
    const host = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && readShadowHost
      ? readShadowHost(root)
      : getProperty(root, 'host');
    return host instanceof Element ? host : null;
  };
  const hasInlineHandler = (target: EventTarget, type: string): boolean =>
    typeof getProperty(target, `on${type.toLowerCase()}`) === 'function';
  const armActivatedIntent = (event: Event, path: EventTarget[]): void => {
    const type = event.type.toLowerCase();
    const isAuthorizedActivation = type === 'click'
      || ((type === 'keydown' || type === 'keypress') && getProperty(event, 'key') === 'Enter');
    if (!isAuthorizedActivation) return;
    for (const target of path) {
      const armed = getArmedIntent(target);
      if (!armed) continue;
      if (type === 'click' && (armed.inspectElement === null
        || (armed.submitter !== null && path.includes(armed.submitter)))) {
        armed.activationSeen = true;
      }
      if (type !== 'click' && armed.inspectElement === null) armed.activationSeen = true;
    }
  };
  const guardUnverifiedHandlers: EventListener = (event) => {
    const type = event.type.toLowerCase();
    const path = callComposedPath(event) as EventTarget[];
    const hasPathHandler = path.some((target) =>
      hasListener(target, type) || hasInlineHandler(target, type));
    const changedArmedIntent = path.some((target) => {
      const armed = getArmedIntent(target);
      if (!armed) return false;
      try {
        return stringify(policyInspector(armed.inspectElement)) !== armed.fingerprint;
      } catch {
        return true;
      }
    });
    const hasArmedIntent = path.some((target) => getArmedIntent(target) !== undefined);
    const keyboardEnter = (type === 'keydown' || type === 'keypress')
      && getProperty(event, 'key') === 'Enter';
    const submitter = getProperty(event, 'submitter') as Element | null | undefined;
    const authorizedSubmit = path.some((target) => {
      const armed = getArmedIntent(target);
      return armed !== undefined
        && armed.activationSeen
        && (armed.submitter === null
          ? armed.inspectElement === null
          : armed.submitter === submitter);
    });
    const missingArmedIntent = ((type === 'click' || type === 'auxclick' || keyboardEnter) && !hasArmedIntent)
      || (type === 'submit' && !authorizedSubmit);
    const hasLifecycleHandler = eventTypes.some((eventType) =>
      isLifecycleInteraction(eventType)
      && [window, document].some((target) =>
        hasListener(target, eventType) || hasInlineHandler(target, eventType)));
    if (hasPathHandler || changedArmedIntent || missingArmedIntent
      || (hasLifecycleHandler && isInteractionEvent(type))) {
      blockedInteractionCount += 1;
      callPreventDefault(event);
      callStopImmediatePropagation(event);
      if (type === 'submit') {
        for (const target of path) deleteArmedIntent(target);
      }
      return;
    }
    armActivatedIntent(event, path);
    if (type === 'submit') {
      for (const target of path) deleteArmedIntent(target);
    }
  };
  for (const type of eventTypes) {
    callOriginalAddEventListener(window, type, guardUnverifiedHandlers, { capture: true });
  }
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener && isInteractionEvent(type.toLowerCase())) trackListener(this, type);
    callOriginalAddEventListener(this, type, listener, options);
  };
  Object.defineProperty(EventTarget.prototype, 'addEventListener', {
    configurable: false,
    writable: false,
  });
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = callOriginalAttachShadow(this, init) as ShadowRoot;
    trackShadowRoot(this, root);
    return root;
  };
  Object.defineProperty(Element.prototype, 'attachShadow', {
    configurable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksHasInteractionListener', {
    value: hasListener,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetShadowRoot', {
    value: getShadowRoot,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetBlockedInteractionCount', {
    value: () => blockedInteractionCount,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArmInteraction', {
    value: armInteraction,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksClearInteraction', {
    value: clearInteraction,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetAttribute', {
    value: getTrustedAttribute,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksMatchesElement', {
    value: trustedMatches,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetTextContent', {
    value: getTrustedTextContent,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetProperty', {
    value: getProperty,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetComposedParent', {
    value: getComposedParent,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

/** Runs in Chromium to inspect control labels, routes, fields, and script-driven intent. */
export function inspectBrowserPolicy(element: Element | null): BrowserPolicyInspection {
  const securityAccess = window as Window & {
    __agentTasksGetAttribute?: (target: Element, name: string) => string | null;
    __agentTasksMatchesElement?: (target: Element, selector: string) => boolean;
    __agentTasksGetTextContent?: (target: Node) => string | null;
    __agentTasksGetProperty?: (target: object, property: PropertyKey) => unknown;
    __agentTasksGetComposedParent?: (target: Element) => Element | null;
  };
  const readAttribute = securityAccess.__agentTasksGetAttribute;
  const matchesElement = securityAccess.__agentTasksMatchesElement;
  const readTextContent = securityAccess.__agentTasksGetTextContent;
  const getProperty = securityAccess.__agentTasksGetProperty;
  const getComposedParent = securityAccess.__agentTasksGetComposedParent;
  if (!readAttribute || !matchesElement || !readTextContent || !getProperty || !getComposedParent) return null;
  const hasTrackedInteractionListener = (window as Window & {
    __agentTasksHasInteractionListener?: (target: EventTarget) => boolean;
  }).__agentTasksHasInteractionListener;
  const getTrackedShadowRoot = (window as Window & {
    __agentTasksGetShadowRoot?: (host: Element) => ShadowRoot | undefined;
  }).__agentTasksGetShadowRoot;
  const pageUrl = window.location?.href ?? '';
  const interactionEventTypes = [
    'auxclick', 'blur', 'change', 'click', 'contextmenu', 'dblclick', 'focus', 'focusin', 'focusout', 'formdata',
    'input', 'keydown', 'keypress', 'keyup', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove',
    'mouseout', 'mouseover', 'mouseup', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove',
    'pointerout', 'pointerover', 'pointerup', 'submit', 'touchcancel', 'touchend', 'touchmove', 'touchstart',
    'beforeunload', 'hashchange', 'pagehide', 'pageshow', 'popstate', 'unload', 'visibilitychange',
  ];
  const hasDirectScriptHandler = (target: EventTarget): boolean => {
    if (!hasTrackedInteractionListener || !getTrackedShadowRoot) return true;
    if (hasTrackedInteractionListener(target)) return true;
    return interactionEventTypes.some((type) =>
      (target instanceof Element && readAttribute(target, `on${type}`) !== null)
      || typeof getProperty(target, `on${type}`) === 'function');
  };
  const hasScriptHandlers = (node: Element): boolean => {
    if (hasDirectScriptHandler(window) || hasDirectScriptHandler(document)) return true;
    if (!(node instanceof Element)) return hasDirectScriptHandler(node);
    for (let current: Element | null = node; current;) {
      if (hasDirectScriptHandler(current)) return true;
      const assignedSlot: HTMLSlotElement | null = current.assignedSlot;
      if (assignedSlot) {
        current = assignedSlot;
        continue;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root: Node = current.getRootNode();
      const host: unknown = getProperty(root, 'host');
      if (host instanceof Element) {
        if (hasDirectScriptHandler(root as EventTarget)) return true;
        current = host;
      } else {
        current = null;
      }
    }
    return false;
  };
  const hasDescendantScriptHandlers = (node: Element): boolean => {
    if (!hasTrackedInteractionListener || !getTrackedShadowRoot) return true;
    const pending = [node];
    const visited = new Set<Element>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (current !== node && hasDirectScriptHandler(current)) return true;
      pending.push(...Array.from(current.children));
      const shadowRoot = getTrackedShadowRoot(current) ?? current.shadowRoot;
      if (shadowRoot) {
        if (hasDirectScriptHandler(shadowRoot)) return true;
        pending.push(...Array.from(shadowRoot.children));
      }
      if (current.localName === 'slot') {
        pending.push(...Array.from((current as HTMLSlotElement).assignedElements({ flatten: true })));
      }
    }
    return false;
  };
  const accessibleName = (node: Element, visited = new Set<Element>()): string => {
    if (visited.has(node)) return '';
    const nextVisited = new Set(visited);
    nextVisited.add(node);

    const labelledBy = readAttribute(node, 'aria-labelledby');
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter((reference): reference is HTMLElement => reference !== null)
        .map((reference) => accessibleName(reference, new Set(nextVisited)))
        .filter(Boolean);
      if (names.length > 0) return names.join(' ');
    }

    const ariaLabel = readAttribute(node, 'aria-label');
    if (ariaLabel) return ariaLabel;
    if (node instanceof HTMLImageElement) return node.alt || node.title || '';
    if (node instanceof HTMLInputElement) {
      if (node.type === 'image') return node.alt || node.value || node.title || '';
      if (node.type === 'submit' || node.type === 'button' || node.type === 'reset') return node.value || node.title || '';
    }

    const labels = node instanceof HTMLInputElement
      || node instanceof HTMLButtonElement
      || node instanceof HTMLSelectElement
      || node instanceof HTMLTextAreaElement
      ? Array.from(node.labels ?? [])
      : [];
    const labelNames = labels
      .map((label) => accessibleName(label, new Set(nextVisited)))
      .filter(Boolean);
    if (labelNames.length > 0) return labelNames.join(' ');

    const contents = Array.from(node.childNodes)
      .map((child) => child instanceof Element
        ? accessibleName(child, new Set(nextVisited))
        : readTextContent(child) ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return contents || readTextContent(node)?.trim() || readAttribute(node, 'title') || '';
  };

  const labelFor = (node: Element): string => [
    accessibleName(node),
    readTextContent(node) ?? '',
    readAttribute(node, 'value') ?? '',
    readAttribute(node, 'title') ?? '',
    readAttribute(node, 'name') ?? '',
    readAttribute(node, 'type') ?? '',
    readAttribute(node, 'alt') ?? '',
  ].filter(Boolean).join(' ');

  const fieldsFor = (form: HTMLFormElement, methodOverride = form.method): Array<{ name: string; value: string }> => {
    const method = methodOverride.toLowerCase();
    const actionFieldNames = new Set(['action', 'command', 'do', 'event', 'handler', 'intent', 'mode', 'op', 'operation', 'task', 'workflow']);
    return Array.from(form.elements).flatMap((candidate) => {
      if (!(candidate instanceof HTMLInputElement
        || candidate instanceof HTMLButtonElement
        || candidate instanceof HTMLSelectElement
        || candidate instanceof HTMLTextAreaElement)
        || candidate.disabled
        || !candidate.name) return [];

      if (candidate instanceof HTMLInputElement && ['checkbox', 'radio'].includes(candidate.type) && !candidate.checked) return [];
      if (candidate instanceof HTMLInputElement && candidate.type === 'file') return [];
      if (candidate instanceof HTMLSelectElement && candidate.multiple) {
        return Array.from(candidate.selectedOptions)
          .filter((option) => !option.disabled)
          .map((option) => ({ name: candidate.name, value: option.value }));
      }
      const isHiddenInput = candidate instanceof HTMLInputElement && candidate.type === 'hidden';
      const normalizedName = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (method !== 'get' && !isHiddenInput && !actionFieldNames.has(normalizedName)) return [];

      return [{ name: candidate.name, value: candidate.value }];
    });
  };
  const hasFormScriptHandlers = (form: HTMLFormElement): boolean =>
    hasScriptHandlers(form) || Array.from(form.elements).some((candidate) => hasScriptHandlers(candidate));

  if (element) {
    const hasUnverifiedDescendantHandlers = hasDescendantScriptHandlers(element);
    const nodes = new Set<Element>([element]);
    const interactiveSelector = 'a[href], area[href], button, input[type="submit"], input[type="image"], input[type="button"], label, [role="button"], [role="link"], [onclick]';
    const visitedElements = new Set<Element>();
    const collectFromContainer = (container: ParentNode): void => {
      for (const child of Array.from(container.children)) collectInteractiveElement(child);
    };
    const collectInteractiveElement = (current: Element): void => {
      if (visitedElements.has(current)) return;
      visitedElements.add(current);
      if (matchesElement(current, interactiveSelector)) nodes.add(current);
      collectFromContainer(current);
      const shadowRoot = getTrackedShadowRoot?.(current) ?? current.shadowRoot;
      if (shadowRoot) collectFromContainer(shadowRoot);
      if (current.localName === 'slot') {
        for (const assigned of Array.from((current as HTMLSlotElement).assignedElements({ flatten: true }))) {
          collectInteractiveElement(assigned);
        }
      }
    };
    collectFromContainer(element);
    const selectedShadowRoot = getTrackedShadowRoot?.(element) ?? element.shadowRoot;
    if (selectedShadowRoot) collectFromContainer(selectedShadowRoot);
    for (let current: Element | null = element; current; current = getComposedParent(current)) {
      if (matchesElement(current, interactiveSelector)) {
        nodes.add(current);
      }
    }
    for (const node of [...nodes]) {
      if (node instanceof HTMLLabelElement && node.control) nodes.add(node.control);
      if (node instanceof HTMLInputElement
        || node instanceof HTMLButtonElement
        || node instanceof HTMLSelectElement
        || node instanceof HTMLTextAreaElement) {
        for (const label of Array.from(node.labels ?? [])) nodes.add(label);
      }
    }
    return {
      kind: 'click',
      pageUrl,
      targets: Array.from(nodes).map((node) => {
        const form = node instanceof HTMLButtonElement && node.type === 'submit'
          ? node.form
          : node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')
            ? node.form
            : null;
        const formAction = form
          ? node instanceof HTMLButtonElement || node instanceof HTMLInputElement
            ? readAttribute(node, 'formaction') !== null ? node.formAction : form.action
            : null
          : null;
        const formMethod = form && (node instanceof HTMLButtonElement || node instanceof HTMLInputElement)
          ? readAttribute(node, 'formmethod') !== null ? node.formMethod : form.method
          : null;
        return {
          label: labelFor(node),
          href: readAttribute(node, 'href'),
          formAction,
          formFields: form && formMethod ? fieldsFor(form, formMethod) : [],
          hasScriptHandlers: (node === element && hasUnverifiedDescendantHandlers)
            || (form ? hasFormScriptHandlers(form) : hasScriptHandlers(node)),
        };
      }),
    };
  }

  const active = document.activeElement;
  const form = active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active instanceof HTMLSelectElement
    ? active.form
    : null;
  if (!form) return null;
  const submitters = Array.from(form.elements)
    .filter((candidate): candidate is HTMLButtonElement | HTMLInputElement => {
      if (candidate instanceof HTMLButtonElement) return candidate.type === 'submit' && !candidate.disabled;
      return candidate instanceof HTMLInputElement
        && (candidate.type === 'submit' || candidate.type === 'image')
        && !candidate.disabled;
    })
    .map((candidate) => ({
      label: labelFor(candidate),
      formAction: readAttribute(candidate, 'formaction') !== null ? candidate.formAction : form.action,
      hasScriptHandlers: hasScriptHandlers(candidate),
    }));
  const hasGetSubmitter = Array.from(form.elements).some((candidate) =>
    ((candidate instanceof HTMLButtonElement && candidate.type === 'submit')
      || (candidate instanceof HTMLInputElement && (candidate.type === 'submit' || candidate.type === 'image')))
    && !candidate.disabled
    && readAttribute(candidate, 'formmethod') !== null
    && candidate.formMethod.toLowerCase() === 'get');
  const method = form.method.toLowerCase();
  return {
    kind: 'form',
    pageUrl,
    formAction: form.action,
    method,
    fields: fieldsFor(form, hasGetSubmitter ? 'get' : method),
    hasScriptHandlers: hasFormScriptHandlers(form),
    submitters,
  };
}

function isForbiddenFormIntent(
  formAction: string,
  fields: readonly { name: string; value: string }[],
  pageUrl: string,
): boolean {
  try {
    const submissionUrl = new URL(formAction, pageUrl);
    for (const { name, value } of fields) submissionUrl.searchParams.append(name, value);
    return isForbiddenFormUrl(submissionUrl.toString());
  } catch {
    return true;
  }
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
  intentToken: string;
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
    const intentToken = randomUUID();
    await context.addInitScript(
      `(${installInteractionListenerTracking.toString()})(${JSON.stringify(intentToken)}, ${inspectBrowserPolicy.toString()})`,
    );
    const page = await context.newPage();
    page.setDefaultTimeout(this.limits.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.limits.actionTimeoutMs);
    // Only http(s) leaves the browser; everything else is dropped before the proxy.
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = request.url();
      if (!/^https?:/i.test(url)) return route.abort('blockedbyclient');
      if (request.isNavigationRequest() && request.redirectedFrom()
        && isForbiddenClickTarget('', { href: url })) {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const id = randomUUID();
    this.sessions.set(id, { id, intentToken, context, page, createdAt: Date.now(), lastActionAt: Date.now(), actions: 0 });
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
    const readBlockedInteractionCount = (): Promise<number | null> => page.evaluate(() => {
      const readCount = (window as Window & {
        __agentTasksGetBlockedInteractionCount?: () => number;
      }).__agentTasksGetBlockedInteractionCount;
      return typeof readCount === 'function' ? readCount() : null;
    });
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
        const target = await page.locator(action.selector).first().elementHandle({ timeout: this.limits.actionTimeoutMs });
        if (!target) {
          return { ok: false, action: 'click_element', error: 'the selected control could not be safely resolved' };
        }
        const inspection = await target.evaluate(inspectBrowserPolicy).catch(() => null);
        if (!inspection || inspection.kind !== 'click'
          || inspection.targets.some(({ label, href, formAction, formFields, hasScriptHandlers }) =>
            hasScriptHandlers
            || isForbiddenClickTarget(label, { href, formAction, pageUrl: inspection.pageUrl })
            || (formAction !== null && isForbiddenFormIntent(formAction, formFields, inspection.pageUrl)))) {
          return { ok: false, action: 'click_element', error: 'clicking controls with unverified script behavior, authentication, payment or destructive actions is not allowed' };
        }
        const armed = await target.evaluate((element, input: { token: string; fingerprint: string }) => {
          const arm = (window as Window & {
            __agentTasksArmInteraction?: (target: Element | null, token: string, fingerprint: string) => boolean;
          }).__agentTasksArmInteraction;
          return typeof arm === 'function' && arm(element, input.token, input.fingerprint);
        }, { token: session.intentToken, fingerprint: JSON.stringify(inspection) });
        if (!armed) {
          return { ok: false, action: 'click_element', error: 'the selected control changed after policy inspection' };
        }
        const blockedBefore = await readBlockedInteractionCount();
        if (blockedBefore === null) {
          return { ok: false, action: 'click_element', error: 'interaction tracking is unavailable' };
        }
        try {
          await target.click({ timeout: this.limits.actionTimeoutMs });
        } finally {
          await target.evaluate((element, token: string) => {
            const clear = (window as Window & {
              __agentTasksClearInteraction?: (target: Element | null, intentToken: string) => boolean;
            }).__agentTasksClearInteraction;
            return typeof clear === 'function' && clear(element, token);
          }, session.intentToken).catch(() => false);
        }
        const blockedAfter = await readBlockedInteractionCount();
        if (blockedAfter === null || blockedAfter > blockedBefore) {
          return { ok: false, action: 'click_element', error: 'script-driven interaction was blocked' };
        }
        await page.waitForLoadState('domcontentloaded', { timeout: this.limits.actionTimeoutMs }).catch(() => undefined);
        return { ok: true, action: 'click_element', url: page.url(), title: await page.title() };
      }
      case 'fill_form': {
        for (const field of action.fields) {
          const target = await page.locator(field.selector).first().elementHandle({ timeout: this.limits.actionTimeoutMs });
          if (!target) {
            return { ok: false, action: 'fill_form', error: 'a form field could not be safely resolved' };
          }
          const inspection = await target.evaluate(inspectBrowserPolicy).catch(() => null);
          if (!inspection || inspection.kind !== 'click'
            || inspection.targets.some(({ hasScriptHandlers }) => hasScriptHandlers)) {
            return { ok: false, action: 'fill_form', error: 'filling controls with unverified script behavior is not allowed' };
          }
          const blockedBefore = await readBlockedInteractionCount();
          if (blockedBefore === null) {
            return { ok: false, action: 'fill_form', error: 'interaction tracking is unavailable' };
          }
          await target.fill(field.value, { timeout: this.limits.actionTimeoutMs });
          const blockedAfter = await readBlockedInteractionCount();
          if (blockedAfter === null || blockedAfter > blockedBefore) {
            return { ok: false, action: 'fill_form', error: 'script-driven interaction was blocked while filling a field' };
          }
        }
        if (action.submit) {
          const inspection = await page.evaluate(inspectBrowserPolicy, null);
          if (!inspection || inspection.kind !== 'form'
            || inspection.hasScriptHandlers
            || isForbiddenClickTarget('', { formAction: inspection.formAction, pageUrl: inspection.pageUrl })
            || isForbiddenFormIntent(inspection.formAction, inspection.fields, inspection.pageUrl)
            || inspection.submitters.some(({ label, formAction, hasScriptHandlers }) =>
              hasScriptHandlers || isForbiddenClickTarget(label, { formAction, pageUrl: inspection.pageUrl }))) {
            return { ok: false, action: 'fill_form', error: 'submitting a form with unverified script behavior, authentication, payment or destructive intent is not allowed' };
          }
          const armed = await page.evaluate((input: { token: string; fingerprint: string }) => {
            const arm = (window as Window & {
              __agentTasksArmInteraction?: (target: Element | null, token: string, fingerprint: string) => boolean;
            }).__agentTasksArmInteraction;
            return typeof arm === 'function' && arm(null, input.token, input.fingerprint);
          }, { token: session.intentToken, fingerprint: JSON.stringify(inspection) });
          if (!armed) {
            return { ok: false, action: 'fill_form', error: 'the form changed after policy inspection' };
          }
          const blockedBefore = await readBlockedInteractionCount();
          if (blockedBefore === null) {
            return { ok: false, action: 'fill_form', error: 'interaction tracking is unavailable' };
          }
          try {
            await page.keyboard.press('Enter');
          } finally {
            await page.evaluate((token: string) => {
              const clear = (window as Window & {
                __agentTasksClearInteraction?: (target: Element | null, intentToken: string) => boolean;
              }).__agentTasksClearInteraction;
              return typeof clear === 'function' && clear(null, token);
            }, session.intentToken).catch(() => false);
          }
          const blockedAfter = await readBlockedInteractionCount();
          if (blockedAfter === null || blockedAfter > blockedBefore) {
            return { ok: false, action: 'fill_form', error: 'script-driven form submission was blocked' };
          }
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
