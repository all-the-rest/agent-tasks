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

type NativeConstructor = abstract new (...args: never[]) => unknown;

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
    'invalid', 'pointerout', 'pointerover', 'pointerup', 'submit', 'touchcancel', 'touchend', 'touchmove', 'touchstart',
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
          addType(callStringToLowerCase(eventType));
          hasAny = true;
        },
        hasType: (eventType?: string) => eventType === undefined
          ? hasAny
          : containsType(callStringToLowerCase(eventType)),
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
  const callArrayMap = Function.prototype.call.bind(Array.prototype.map) as <T, U>(
    items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => U,
  ) => U[];
  const callArrayFilter = Function.prototype.call.bind(Array.prototype.filter) as <T>(
    items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => boolean,
  ) => T[];
  const callArraySome = Function.prototype.call.bind(Array.prototype.some) as <T>(
    items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => boolean,
  ) => boolean;
  const callArrayPop = Function.prototype.call.bind(Array.prototype.pop) as <T>(items: T[]) => T | undefined;
  const callArrayPush = Function.prototype.call.bind(Array.prototype.push) as <T>(items: T[], ...values: T[]) => number;
  const callArrayIncludes = Function.prototype.call.bind(Array.prototype.includes) as <T>(items: readonly T[], value: T) => boolean;
  const callArrayJoin = Function.prototype.call.bind(Array.prototype.join) as (items: readonly unknown[], separator?: string) => string;
  const callStringToLowerCase = Function.prototype.call.bind(String.prototype.toLowerCase) as (value: string) => string;
  const callStringTrim = Function.prototype.call.bind(String.prototype.trim) as (value: string) => string;
  const callStringCharAt = Function.prototype.call.bind(String.prototype.charAt) as (value: string, index: number) => string;
  const callStringCharCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt) as (value: string, index: number) => number;
  const nativeIsSafeInteger = Number.isSafeInteger;
  const NativeSet = Set;
  const callSetAdd = Function.prototype.call.bind(NativeSet.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
  const callSetHas = Function.prototype.call.bind(NativeSet.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
  const callSetForEach = Function.prototype.call.bind(NativeSet.prototype.forEach) as <T>(
    set: Set<T>, callback: (value: T) => void,
  ) => void;
  const callFunctionHasInstance = Function.prototype.call.bind(Function.prototype[Symbol.hasInstance]) as (
    constructor: NativeConstructor,
    value: unknown,
  ) => boolean;
  const nativeConstructors = Object.create(null) as Record<string, NativeConstructor | undefined>;
  const captureNativeConstructor = (name: string, constructor: NativeConstructor | undefined): void => {
    if (constructor) nativeConstructors[name] = constructor;
  };
  captureNativeConstructor('Set', NativeSet);
  captureNativeConstructor('Element', typeof Element === 'undefined' ? undefined : Element);
  captureNativeConstructor('ShadowRoot', typeof ShadowRoot === 'undefined' ? undefined : ShadowRoot);
  captureNativeConstructor('HTMLImageElement', typeof HTMLImageElement === 'undefined' ? undefined : HTMLImageElement);
  captureNativeConstructor('HTMLInputElement', typeof HTMLInputElement === 'undefined' ? undefined : HTMLInputElement);
  captureNativeConstructor('HTMLButtonElement', typeof HTMLButtonElement === 'undefined' ? undefined : HTMLButtonElement);
  captureNativeConstructor('HTMLSelectElement', typeof HTMLSelectElement === 'undefined' ? undefined : HTMLSelectElement);
  captureNativeConstructor('HTMLTextAreaElement', typeof HTMLTextAreaElement === 'undefined' ? undefined : HTMLTextAreaElement);
  captureNativeConstructor('HTMLLabelElement', typeof HTMLLabelElement === 'undefined' ? undefined : HTMLLabelElement);
  captureNativeConstructor('HTMLSlotElement', typeof HTMLSlotElement === 'undefined' ? undefined : HTMLSlotElement);
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
  const nativePropertyGetters = Object.create(null) as Record<string, NativeGetter[]>;
  const captureNativeProperty = (prototype: object | undefined, property: string): void => {
    const getter = captureGetter(prototype, property);
    if (!getter) return;
    const getters = nativePropertyGetters[property] ?? (nativePropertyGetters[property] = []);
    getters.push(getter);
  };
  const captureProperties = (prototype: object | undefined, properties: string[]): void => {
    for (const property of properties) captureNativeProperty(prototype, property);
  };
  const getNodeListLength = captureGetter(typeof NodeList === 'undefined' ? undefined : NodeList.prototype, 'length');
  const getHtmlCollectionLength = captureGetter(
    typeof HTMLCollection === 'undefined' ? undefined : HTMLCollection.prototype,
    'length',
  );
  const arrayFrom = <T>(items: Iterable<T> | ArrayLike<T>): T[] => {
    const fromSet: T[] = [];
    let setIndex = 0;
    try {
      callSetForEach(items as Set<T>, (value) => {
        if (setIndex >= 10_000) throw new Error('browser policy collection is too large');
        fromSet[setIndex] = value;
        setIndex += 1;
      });
      return fromSet;
    } catch {
      // Non-Set collections fall through to their captured native length getters.
    }
    let length: unknown;
    const collectionGetters = [getNodeListLength, getHtmlCollectionLength];
    for (let index = 0; index < collectionGetters.length; index += 1) {
      const getter = collectionGetters[index];
      if (!getter) continue;
      try {
        length = getter(items as object);
        break;
      } catch {
        // Try the other native collection brand, then use an array's own length.
      }
    }
    if (typeof length !== 'number') {
      if (typeof items !== 'object' || items === null || !('length' in items)) {
        throw new Error('browser policy value is not a trusted collection');
      }
      length = (items as ArrayLike<T>).length;
    }
    const numericLength = length as number;
    if (!nativeIsSafeInteger(numericLength) || numericLength < 0 || numericLength > 10_000) {
      throw new Error('browser policy collection has an invalid length');
    }
    const result: T[] = [];
    const arrayLike = items as ArrayLike<T>;
    for (let index = 0; index < numericLength; index += 1) result[index] = arrayLike[index] as T;
    return result;
  };
  const getNativeSubmitter = captureGetter(
    typeof SubmitEvent === 'undefined' ? undefined : SubmitEvent.prototype,
    'submitter',
  );
  const getNativeEventType = captureGetter(typeof Event === 'undefined' ? undefined : Event.prototype, 'type');
  const nativeGetElementById = typeof Document === 'undefined' ? undefined : Document.prototype.getElementById;
  const callNativeGetElementById = nativeGetElementById
    ? Function.prototype.call.bind(nativeGetElementById) as (target: Document, id: string) => HTMLElement | null
    : null;
  captureProperties(typeof HTMLFormElement === 'undefined' ? undefined : HTMLFormElement.prototype, ['action', 'method', 'elements']);
  captureProperties(typeof Element === 'undefined' ? undefined : Element.prototype, [
    'localName', 'assignedSlot', 'parentElement', 'shadowRoot', 'children',
  ]);
  captureProperties(typeof DocumentFragment === 'undefined' ? undefined : DocumentFragment.prototype, ['children']);
  captureProperties(typeof Document === 'undefined' ? undefined : Document.prototype, ['activeElement']);
  captureProperties(typeof HTMLElement === 'undefined' ? undefined : HTMLElement.prototype, ['title']);
  captureProperties(typeof ShadowRoot === 'undefined' ? undefined : ShadowRoot.prototype, ['host']);
  captureProperties(typeof Node === 'undefined' ? undefined : Node.prototype, ['childNodes']);
  captureProperties(typeof HTMLInputElement === 'undefined' ? undefined : HTMLInputElement.prototype, [
    'form', 'type', 'formAction', 'formMethod', 'name', 'value', 'disabled', 'checked', 'labels', 'alt',
  ]);
  captureProperties(typeof HTMLImageElement === 'undefined' ? undefined : HTMLImageElement.prototype, ['alt']);
  captureProperties(typeof HTMLButtonElement === 'undefined' ? undefined : HTMLButtonElement.prototype, [
    'form', 'type', 'formAction', 'formMethod', 'name', 'value', 'disabled', 'labels',
  ]);
  captureProperties(typeof HTMLSelectElement === 'undefined' ? undefined : HTMLSelectElement.prototype, [
    'form', 'name', 'disabled', 'multiple', 'value', 'selectedOptions', 'labels',
  ]);
  captureProperties(typeof HTMLTextAreaElement === 'undefined' ? undefined : HTMLTextAreaElement.prototype, [
    'form', 'name', 'value', 'disabled', 'labels',
  ]);
  captureProperties(typeof HTMLOptionElement === 'undefined' ? undefined : HTMLOptionElement.prototype, [
    'value', 'disabled', 'selected',
  ]);
  captureProperties(typeof HTMLLabelElement === 'undefined' ? undefined : HTMLLabelElement.prototype, ['control']);
  captureProperties(typeof KeyboardEvent === 'undefined' ? undefined : KeyboardEvent.prototype, ['key']);
  const nativeAssignedElements = typeof HTMLSlotElement === 'undefined'
    ? undefined
    : HTMLSlotElement.prototype.assignedElements;
  const callNativeAssignedElements = nativeAssignedElements
    ? Function.prototype.call.bind(nativeAssignedElements) as (target: HTMLSlotElement, options?: AssignedNodesOptions) => Element[]
    : null;
  const getTrustedProperty = (target: object, property: string): unknown => {
    const getters = nativePropertyGetters[property];
    if (!getters) return undefined;
    for (let index = 0; index < getters.length; index += 1) {
      try {
        return getters[index]?.(target);
      } catch {
        // Try the next native interface getter; only the matching element brand succeeds.
      }
    }
    return undefined;
  };
  const isNativeInstance = (target: unknown, name: string): boolean => {
    if (typeof target !== 'object' || target === null) return false;
    if (name === 'Set') {
      const setConstructor = nativeConstructors.Set;
      return typeof setConstructor === 'function' && callFunctionHasInstance(setConstructor, target);
    }
    if (name === 'ShadowRoot') {
      const host = getTrustedProperty(target, 'host');
      if (host !== undefined && getTrustedProperty(host as object, 'localName') !== undefined) return true;
      const constructor = nativeConstructors.ShadowRoot;
      return typeof constructor === 'function' && callFunctionHasInstance(constructor, target);
    }
    const localName = getTrustedProperty(target, 'localName');
    if (typeof localName !== 'string') {
      const constructor = nativeConstructors[name];
      return typeof constructor === 'function' && callFunctionHasInstance(constructor, target);
    }
    if (name === 'Element') return true;
    const tagByInterface: Record<string, string> = {
      HTMLImageElement: 'img',
      HTMLInputElement: 'input',
      HTMLButtonElement: 'button',
      HTMLSelectElement: 'select',
      HTMLTextAreaElement: 'textarea',
      HTMLLabelElement: 'label',
      HTMLSlotElement: 'slot',
    };
    return tagByInterface[name] === localName;
  };
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
  const appendArray = <T>(target: T[], values: readonly T[]): void => {
    for (let index = 0; index < values.length; index += 1) {
      callArrayPush(target, values[index] as T);
    }
  };
  const formForActiveElement = (active: Element | null): HTMLFormElement | null => {
    if (!active) return null;
    const nativeForm = getTrustedProperty(active, 'form');
    if (nativeForm !== undefined) return nativeForm as HTMLFormElement | null;
    return active.closest('form');
  };
  const getActiveElement = (): Element | null => {
    const activeElement = getTrustedProperty(document, 'activeElement');
    return activeElement === undefined ? document.activeElement : activeElement as Element | null;
  };
  const armInteraction = (
    element: Element | null,
    token: string,
    expectedFingerprint: string,
  ): boolean => {
    if (token !== intentToken) return false;
    const form = formForActiveElement(getActiveElement());
    const actionTarget: EventTarget | null = element ?? form;
    if (!actionTarget) return false;
    let fingerprint: string | undefined;
    try {
      fingerprint = stringify(policyInspector(element));
    } catch {
      return false;
    }
    if (fingerprint !== expectedFingerprint) return false;
    const isButton = isNativeInstance(element, 'HTMLButtonElement');
    const isInput = isNativeInstance(element, 'HTMLInputElement');
    const isFormControl = isButton || isInput;
    const formOwner = element && isFormControl ? getTrustedProperty(element, 'form') as HTMLFormElement | null : null;
    const type = element && isFormControl ? getTrustedProperty(element, 'type') : undefined;
    const isSubmitter = isButton && type === 'submit'
      || isInput && (type === 'submit' || type === 'image');
    const state = { fingerprint, inspectElement: element, submitter: isSubmitter ? element : null, activationSeen: false };
    setArmedIntent(actionTarget, state);
    if (isSubmitter && formOwner) {
      setArmedIntent(formOwner, state);
    }
    return true;
  };
  const clearInteraction = (element: Element | null, token: string): boolean => {
    if (token !== intentToken) return false;
    const activeForm = element ? null : formForActiveElement(getActiveElement());
    const target = element ?? activeForm;
    if (!target) return false;
    deleteArmedIntent(target);
    const formOwner = element && (isNativeInstance(element, 'HTMLButtonElement') || isNativeInstance(element, 'HTMLInputElement'))
      ? getTrustedProperty(element, 'form') as HTMLFormElement | null
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
    const host = isNativeInstance(root, 'ShadowRoot') && readShadowHost
      ? readShadowHost(root)
      : getProperty(root, 'host');
    return isNativeInstance(host, 'Element') ? host as Element : null;
  };
  const hasInlineHandler = (target: EventTarget, type: string): boolean =>
    typeof getProperty(target, `on${callStringToLowerCase(type)}`) === 'function';
  const armActivatedIntent = (event: Event, path: EventTarget[]): void => {
    const type = callStringToLowerCase((getNativeEventType?.(event) as string | undefined) ?? event.type);
    const isAuthorizedActivation = type === 'click'
      || ((type === 'keydown' || type === 'keypress') && getTrustedProperty(event, 'key') === 'Enter');
    if (!isAuthorizedActivation) return;
    for (let index = 0; index < path.length; index += 1) {
      const target = path[index];
      if (!target) continue;
      const armed = getArmedIntent(target);
      if (!armed) continue;
      if (type === 'click' && (armed.inspectElement === null
        || (armed.submitter !== null && callArrayIncludes(path, armed.submitter)))) {
        armed.activationSeen = true;
      }
      if (type !== 'click' && armed.inspectElement === null) armed.activationSeen = true;
    }
  };
  const guardUnverifiedHandlers: EventListener = (event) => {
    const type = callStringToLowerCase((getNativeEventType?.(event) as string | undefined) ?? event.type);
    const path = callComposedPath(event) as EventTarget[];
    const hasPathHandler = callArraySome(path, (target) =>
      hasListener(target, type) || hasInlineHandler(target, type));
    const changedArmedIntent = callArraySome(path, (target) => {
      const armed = getArmedIntent(target);
      if (!armed) return false;
      try {
        return stringify(policyInspector(armed.inspectElement)) !== armed.fingerprint;
      } catch {
        return true;
      }
    });
    const hasArmedIntent = callArraySome(path, (target) => getArmedIntent(target) !== undefined);
    const keyboardEnter = (type === 'keydown' || type === 'keypress')
      && getTrustedProperty(event, 'key') === 'Enter';
    let submitter: Element | null | undefined;
    if (type === 'submit' && getNativeSubmitter) {
      try {
        submitter = getNativeSubmitter(event) as Element | null;
      } catch {
        submitter = undefined;
      }
    }
    const authorizedSubmit = type === 'submit'
      && submitter !== undefined
      && callArraySome(path, (target) => {
        const armed = getArmedIntent(target);
        return armed !== undefined
          && armed.activationSeen
          && (armed.submitter === null
            ? armed.inspectElement === null
            : armed.submitter === submitter);
      });
    const missingArmedIntent = ((type === 'click' || type === 'auxclick' || keyboardEnter) && !hasArmedIntent)
      || (type === 'submit' && !authorizedSubmit);
    const hasLifecycleHandler = callArraySome(eventTypes, (eventType) =>
      isLifecycleInteraction(eventType)
      && callArraySome([window, document], (target) =>
        hasListener(target, eventType) || hasInlineHandler(target, eventType)));
    if (hasPathHandler || changedArmedIntent || missingArmedIntent
      || (hasLifecycleHandler && isInteractionEvent(type))) {
      blockedInteractionCount += 1;
      callPreventDefault(event);
      callStopImmediatePropagation(event);
      if (type === 'submit') {
        for (let index = 0; index < path.length; index += 1) {
          const target = path[index];
          if (target) deleteArmedIntent(target);
        }
      }
      return;
    }
    armActivatedIntent(event, path);
    if (type === 'submit') {
      for (let index = 0; index < path.length; index += 1) {
        const target = path[index];
        if (target) deleteArmedIntent(target);
      }
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
    if (listener && isInteractionEvent(callStringToLowerCase(type))) trackListener(this, type);
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
  Object.defineProperty(window, '__agentTasksArrayFrom', {
    value: arrayFrom,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetNativeProperty', {
    value: getTrustedProperty,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetNativeRoot', {
    value: (node: Node) => callGetRootNode ? callGetRootNode(node) : null,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetAssignedElements', {
    value: (slot: Element) => callNativeAssignedElements
      ? callNativeAssignedElements(slot as HTMLSlotElement, { flatten: true })
      : null,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksGetElementById', {
    value: (id: string) => {
      if (callNativeGetElementById) {
        try {
          return callNativeGetElementById(document, id);
        } catch {
          // Unit-test DOMs may not implement the native Document brand.
        }
      }
      return document.getElementById(id);
    },
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksStringToLowerCase', {
    value: callStringToLowerCase,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksStringTrim', {
    value: callStringTrim,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksStringCharAt', {
    value: callStringCharAt,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksStringCharCodeAt', {
    value: callStringCharCodeAt,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksIsNativeInstance', {
    value: isNativeInstance,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArrayMap', {
    value: callArrayMap,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArrayFilter', {
    value: callArrayFilter,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArraySome', {
    value: callArraySome,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArrayIncludes', {
    value: callArrayIncludes,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArrayJoin', {
    value: callArrayJoin,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksAppendArray', {
    value: appendArray,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksArrayPop', {
    value: callArrayPop,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksCreateSet', {
    value: <T>() => new NativeSet<T>(),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksSetAdd', {
    value: callSetAdd,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, '__agentTasksSetHas', {
    value: callSetHas,
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
    __agentTasksArrayFrom?: <T>(items: Iterable<T> | ArrayLike<T>) => T[];
    __agentTasksGetNativeProperty?: (target: object, property: string) => unknown;
    __agentTasksGetNativeRoot?: (node: Node) => Node | null;
    __agentTasksGetAssignedElements?: (slot: Element) => Element[] | null;
    __agentTasksGetElementById?: (id: string) => HTMLElement | null;
    __agentTasksStringToLowerCase?: (value: string) => string;
    __agentTasksStringTrim?: (value: string) => string;
    __agentTasksStringCharAt?: (value: string, index: number) => string;
    __agentTasksStringCharCodeAt?: (value: string, index: number) => number;
    __agentTasksIsNativeInstance?: (target: unknown, name: string) => boolean;
    __agentTasksArrayMap?: <T, U>(items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => U) => U[];
    __agentTasksArrayFilter?: <T>(items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => boolean) => T[];
    __agentTasksArraySome?: <T>(items: readonly T[], callback: (value: T, index: number, array: readonly T[]) => boolean) => boolean;
    __agentTasksArrayIncludes?: <T>(items: readonly T[], value: T) => boolean;
    __agentTasksArrayJoin?: (items: readonly unknown[], separator?: string) => string;
    __agentTasksAppendArray?: <T>(target: T[], values: readonly T[]) => void;
    __agentTasksArrayPop?: <T>(items: T[]) => T | undefined;
    __agentTasksCreateSet?: <T>() => Set<T>;
    __agentTasksSetAdd?: <T>(set: Set<T>, value: T) => Set<T>;
    __agentTasksSetHas?: <T>(set: Set<T>, value: T) => boolean;
  };
  const readAttribute = securityAccess.__agentTasksGetAttribute;
  const matchesElement = securityAccess.__agentTasksMatchesElement;
  const readTextContent = securityAccess.__agentTasksGetTextContent;
  const getProperty = securityAccess.__agentTasksGetProperty;
  const getComposedParent = securityAccess.__agentTasksGetComposedParent;
  const arrayFrom = securityAccess.__agentTasksArrayFrom;
  const getNativeProperty = securityAccess.__agentTasksGetNativeProperty;
  const getNativeRoot = securityAccess.__agentTasksGetNativeRoot;
  const getAssignedElements = securityAccess.__agentTasksGetAssignedElements;
  const getElementById = securityAccess.__agentTasksGetElementById;
  const stringToLowerCase = securityAccess.__agentTasksStringToLowerCase;
  const stringTrim = securityAccess.__agentTasksStringTrim;
  const stringCharAt = securityAccess.__agentTasksStringCharAt;
  const stringCharCodeAt = securityAccess.__agentTasksStringCharCodeAt;
  const isNativeInstance = securityAccess.__agentTasksIsNativeInstance;
  const arrayMap = securityAccess.__agentTasksArrayMap;
  const arrayFilter = securityAccess.__agentTasksArrayFilter;
  const arraySome = securityAccess.__agentTasksArraySome;
  const arrayIncludes = securityAccess.__agentTasksArrayIncludes;
  const arrayJoin = securityAccess.__agentTasksArrayJoin;
  const appendArray = securityAccess.__agentTasksAppendArray;
  const arrayPop = securityAccess.__agentTasksArrayPop;
  const createSet = securityAccess.__agentTasksCreateSet;
  const setAdd = securityAccess.__agentTasksSetAdd;
  const setHas = securityAccess.__agentTasksSetHas;
  if (!readAttribute || !matchesElement || !readTextContent || !getProperty || !getComposedParent
    || !arrayFrom || !getNativeProperty || !getNativeRoot || !getAssignedElements || !getElementById
    || !stringToLowerCase || !stringTrim || !stringCharAt || !stringCharCodeAt
    || !isNativeInstance || !arrayMap || !arrayFilter || !arraySome
    || !arrayIncludes || !arrayJoin || !appendArray || !arrayPop || !createSet || !setAdd || !setHas) return null;
  const hasTrackedInteractionListener = (window as Window & {
    __agentTasksHasInteractionListener?: (target: EventTarget) => boolean;
  }).__agentTasksHasInteractionListener;
  const getTrackedShadowRoot = (window as Window & {
    __agentTasksGetShadowRoot?: (host: Element) => ShadowRoot | undefined;
  }).__agentTasksGetShadowRoot;
  const pageUrl = window.location?.href ?? '';
  const splitAsciiWhitespace = (value: string): string[] => {
    const result: string[] = [];
    let token = '';
    for (let index = 0; index < value.length; index += 1) {
      const code = stringCharCodeAt(value, index);
      if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) {
        if (token.length > 0) result[result.length] = token;
        token = '';
      } else {
        token += stringCharAt(value, index);
      }
    }
    if (token.length > 0) result[result.length] = token;
    return result;
  };
  const collapseWhitespace = (value: string): string => {
    let result = '';
    let hasWhitespace = false;
    for (let index = 0; index < value.length; index += 1) {
      const code = stringCharCodeAt(value, index);
      const whitespace = code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
      if (whitespace) {
        hasWhitespace = result.length > 0;
      } else {
        if (hasWhitespace) result += ' ';
        result += stringCharAt(value, index);
        hasWhitespace = false;
      }
    }
    return result;
  };
  const interactionEventTypes = [
    'auxclick', 'blur', 'change', 'click', 'contextmenu', 'dblclick', 'focus', 'focusin', 'focusout', 'formdata',
    'input', 'keydown', 'keypress', 'keyup', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove',
    'mouseout', 'mouseover', 'mouseup', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove',
    'invalid', 'pointerout', 'pointerover', 'pointerup', 'submit', 'touchcancel', 'touchend', 'touchmove', 'touchstart',
    'beforeunload', 'hashchange', 'pagehide', 'pageshow', 'popstate', 'unload', 'visibilitychange',
  ];
  const hasDirectScriptHandler = (target: EventTarget): boolean => {
    if (!hasTrackedInteractionListener || !getTrackedShadowRoot) return true;
    if (hasTrackedInteractionListener(target)) return true;
    return arraySome(interactionEventTypes, (type) =>
      (isNativeInstance(target, 'Element') && readAttribute(target as Element, `on${type}`) !== null)
      || typeof getProperty(target, `on${type}`) === 'function');
  };
  const hasScriptHandlers = (node: Element): boolean => {
    if (hasDirectScriptHandler(window) || hasDirectScriptHandler(document)) return true;
    if (!isNativeInstance(node, 'Element')) return hasDirectScriptHandler(node);
    for (let current: Element | null = node; current;) {
      if (hasDirectScriptHandler(current)) return true;
      const root = getNativeRoot(current);
      if (root && isNativeInstance(root, 'ShadowRoot') && hasDirectScriptHandler(root as EventTarget)) return true;
      current = getComposedParent(current);
    }
    return false;
  };
  const hasDescendantScriptHandlers = (node: Element): boolean => {
    if (!hasTrackedInteractionListener || !getTrackedShadowRoot) return true;
    const pending = [node];
    const visited = createSet<Element>();
    while (pending.length > 0) {
      const current = arrayPop(pending);
      if (!current || setHas(visited, current)) continue;
      setAdd(visited, current);
      if (current !== node && hasDirectScriptHandler(current)) return true;
      const children = getNativeProperty(current, 'children');
      if (!children) return true;
      appendArray(pending, arrayFrom(children as ArrayLike<Element>));
      const shadowRoot = getTrackedShadowRoot(current) ?? getNativeProperty(current, 'shadowRoot') as ShadowRoot | null;
      if (shadowRoot) {
        if (hasDirectScriptHandler(shadowRoot)) return true;
        const shadowChildren = getNativeProperty(shadowRoot, 'children');
        if (!shadowChildren) return true;
        appendArray(pending, arrayFrom(shadowChildren as ArrayLike<Element>));
      }
      if (getNativeProperty(current, 'localName') === 'slot') {
        const assignedElements = getAssignedElements(current);
        if (!assignedElements) return true;
        appendArray(pending, arrayFrom(assignedElements));
      }
    }
    return false;
  };
  const accessibleName = (node: Element, visited = createSet<Element>()): string => {
    if (setHas(visited, node)) return '';
    const nextVisited = createSet<Element>();
    const priorNodes = arrayFrom(visited);
    for (let index = 0; index < priorNodes.length; index += 1) {
      const prior = priorNodes[index];
      if (prior) setAdd(nextVisited, prior);
    }
    setAdd(nextVisited, node);

    const labelledBy = readAttribute(node, 'aria-labelledby');
    if (labelledBy) {
      const ids = splitAsciiWhitespace(labelledBy);
      const references = arrayFilter(arrayMap(ids, (id) => getElementById(id)),
        (reference) => reference !== null);
      const names = arrayFilter(
        arrayMap(references, (reference) => accessibleName(reference as HTMLElement, nextVisited)),
        (name) => name.length > 0,
      );
      if (names.length > 0) return arrayJoin(names, ' ');
    }

    const ariaLabel = readAttribute(node, 'aria-label');
    if (ariaLabel) return ariaLabel;
    if (isNativeInstance(node, 'HTMLImageElement')) {
      const alt = getNativeProperty(node, 'alt');
      const title = getNativeProperty(node, 'title');
      return (typeof alt === 'string' ? alt : '') || (typeof title === 'string' ? title : '');
    }
    if (isNativeInstance(node, 'HTMLInputElement')) {
      const type = getNativeProperty(node, 'type');
      const alt = getNativeProperty(node, 'alt');
      const value = getNativeProperty(node, 'value');
      const title = getNativeProperty(node, 'title');
      if (type === 'image') {
        return (typeof alt === 'string' ? alt : '') || (typeof value === 'string' ? value : '')
          || (typeof title === 'string' ? title : '');
      }
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return (typeof value === 'string' ? value : '') || (typeof title === 'string' ? title : '');
      }
    }

    const labels = isNativeInstance(node, 'HTMLInputElement')
      || isNativeInstance(node, 'HTMLButtonElement')
      || isNativeInstance(node, 'HTMLSelectElement')
      || isNativeInstance(node, 'HTMLTextAreaElement')
      ? arrayFrom((getNativeProperty(node, 'labels') as NodeListOf<HTMLLabelElement> | null) ?? [])
      : [];
    const labelNames = arrayFilter(arrayMap(labels, (label) => accessibleName(label, nextVisited)),
      (label) => label.length > 0);
    if (labelNames.length > 0) return arrayJoin(labelNames, ' ');

    const childNodes = getNativeProperty(node, 'childNodes') as NodeListOf<Node> | undefined;
    if (!childNodes) return '';
    const contents = arrayJoin(arrayFilter(arrayMap(arrayFrom(childNodes), (child) => isNativeInstance(child, 'Element')
        ? accessibleName(child as Element, nextVisited)
        : readTextContent(child) ?? '')
      , (value) => value.length > 0), ' ');
    const normalizedContents = stringTrim(collapseWhitespace(contents));
    const textContent = readTextContent(node);
    return normalizedContents || (textContent ? stringTrim(textContent) : '') || readAttribute(node, 'title') || '';
  };

  const labelFor = (node: Element): string => arrayJoin(arrayFilter([
    accessibleName(node),
    readTextContent(node) ?? '',
    readAttribute(node, 'value') ?? '',
    readAttribute(node, 'title') ?? '',
    readAttribute(node, 'name') ?? '',
    readAttribute(node, 'type') ?? '',
    readAttribute(node, 'alt') ?? '',
  ], (value) => value.length > 0), ' ');

  const fieldsFor = (
    form: HTMLFormElement,
    methodOverride = getNativeProperty(form, 'method') as string | undefined,
  ): Array<{ name: string; value: string }> | null => {
    if (typeof methodOverride !== 'string') return null;
    const method = stringToLowerCase(methodOverride);
    const actionFieldNames = createSet<string>();
    const actionNames = ['action', 'command', 'do', 'event', 'handler', 'intent', 'mode', 'op', 'operation', 'task', 'workflow'];
    for (let index = 0; index < actionNames.length; index += 1) {
      setAdd(actionFieldNames, actionNames[index]);
    }
    const elements = getNativeProperty(form, 'elements') as HTMLFormControlsCollection | undefined;
    if (!elements) return null;
    const fields: Array<{ name: string; value: string }> = [];
    const candidates = arrayFrom(elements);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (!candidate || !(isNativeInstance(candidate, 'HTMLInputElement')
        || isNativeInstance(candidate, 'HTMLButtonElement')
        || isNativeInstance(candidate, 'HTMLSelectElement')
        || isNativeInstance(candidate, 'HTMLTextAreaElement'))) continue;

      const disabled = getNativeProperty(candidate, 'disabled');
      const candidateName = getNativeProperty(candidate, 'name');
      if (typeof disabled !== 'boolean' || typeof candidateName !== 'string') return null;
      if (disabled || !candidateName) continue;

      const type = getNativeProperty(candidate, 'type');
      const name = candidateName;
      if (isNativeInstance(candidate, 'HTMLInputElement') && (type === 'checkbox' || type === 'radio')
        && !getNativeProperty(candidate, 'checked')) continue;
      if (isNativeInstance(candidate, 'HTMLInputElement') && type === 'file') continue;
      if (isNativeInstance(candidate, 'HTMLSelectElement') && getNativeProperty(candidate, 'multiple')) {
        const selectedOptions = getNativeProperty(candidate, 'selectedOptions') as HTMLCollectionOf<HTMLOptionElement> | undefined;
        if (!selectedOptions) return null;
        const options = arrayFrom(selectedOptions);
        for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
          const option = options[optionIndex];
          if (!option) return null;
          const optionDisabled = getNativeProperty(option, 'disabled');
          const optionValue = getNativeProperty(option, 'value');
          if (typeof optionDisabled !== 'boolean' || typeof optionValue !== 'string') return null;
          if (!optionDisabled) fields[fields.length] = { name, value: optionValue };
        }
        continue;
      }
      const isHiddenInput = isNativeInstance(candidate, 'HTMLInputElement') && type === 'hidden';
      const loweredName = stringToLowerCase(name);
      let normalizedName = '';
      for (let nameIndex = 0; nameIndex < loweredName.length; nameIndex += 1) {
        const code = stringCharCodeAt(loweredName, nameIndex);
        if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
          normalizedName += stringCharAt(loweredName, nameIndex);
        }
      }
      if (method !== 'get' && !isHiddenInput && !setHas(actionFieldNames, normalizedName)) continue;

      const value = getNativeProperty(candidate, 'value');
      if (typeof value !== 'string') return null;
      fields[fields.length] = { name, value };
    }
    return fields;
  };
  const hasFormScriptHandlers = (form: HTMLFormElement): boolean =>
    hasScriptHandlers(form)
    || arraySome(arrayFrom((getNativeProperty(form, 'elements') as HTMLFormControlsCollection | undefined) ?? []),
      (candidate) => hasScriptHandlers(candidate));

  if (element) {
    const hasUnverifiedDescendantHandlers = hasDescendantScriptHandlers(element);
    const nodes = createSet<Element>();
    setAdd(nodes, element);
    const interactiveSelector = 'a[href], area[href], button, input[type="submit"], input[type="image"], input[type="button"], label, [role="button"], [role="link"], [onclick]';
    const visitedElements = createSet<Element>();
    let incompleteStructure = false;
    const collectFromContainer = (container: ParentNode): void => {
      const children = getNativeProperty(container, 'children') as HTMLCollection | undefined;
      if (!children) {
        incompleteStructure = true;
        return;
      }
      const childNodes = arrayFrom(children);
      for (let index = 0; index < childNodes.length; index += 1) {
        const child = childNodes[index];
        if (child) collectInteractiveElement(child);
      }
    };
    const collectInteractiveElement = (current: Element): void => {
      if (setHas(visitedElements, current)) return;
      setAdd(visitedElements, current);
      if (matchesElement(current, interactiveSelector)) setAdd(nodes, current);
      collectFromContainer(current);
      const shadowRoot = getTrackedShadowRoot?.(current) ?? getNativeProperty(current, 'shadowRoot') as ShadowRoot | null;
      if (shadowRoot) collectFromContainer(shadowRoot);
      if (getNativeProperty(current, 'localName') === 'slot') {
        const assigned = getAssignedElements(current);
        if (!assigned) {
          incompleteStructure = true;
          return;
        }
        for (let index = 0; index < assigned.length; index += 1) {
          const assignedElement = assigned[index];
          if (assignedElement) collectInteractiveElement(assignedElement);
        }
      }
    };
    collectFromContainer(element);
    const selectedShadowRoot = getTrackedShadowRoot?.(element) ?? getNativeProperty(element, 'shadowRoot') as ShadowRoot | null;
    if (selectedShadowRoot) collectFromContainer(selectedShadowRoot);
    for (let current: Element | null = element; current; current = getComposedParent(current)) {
      if (matchesElement(current, interactiveSelector)) {
        setAdd(nodes, current);
      }
    }
    if (incompleteStructure) return null;
    const inspectedNodes = arrayFrom(nodes);
    for (let index = 0; index < inspectedNodes.length; index += 1) {
      const node = inspectedNodes[index];
      if (!node) continue;
      if (isNativeInstance(node, 'HTMLLabelElement')) {
        const control = getNativeProperty(node, 'control') as Element | null;
        if (control) setAdd(nodes, control);
      }
      if (isNativeInstance(node, 'HTMLInputElement')
        || isNativeInstance(node, 'HTMLButtonElement')
        || isNativeInstance(node, 'HTMLSelectElement')
        || isNativeInstance(node, 'HTMLTextAreaElement')) {
        const labels = arrayFrom((getNativeProperty(node, 'labels') as NodeListOf<HTMLLabelElement> | null) ?? []);
        for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
          const label = labels[labelIndex];
          if (label) setAdd(nodes, label);
        }
      }
    }
    let incompleteNativeIntent = false;
    const inspection: BrowserPolicyInspection = {
      kind: 'click',
      pageUrl,
      targets: arrayMap(arrayFrom(nodes), (node) => {
        const isButton = isNativeInstance(node, 'HTMLButtonElement');
        const isInput = isNativeInstance(node, 'HTMLInputElement');
        const type = isButton || isInput ? getNativeProperty(node, 'type') : undefined;
        const isSubmitter = isButton && type === 'submit'
          || isInput && (type === 'submit' || type === 'image');
        const nativeForm = isSubmitter ? getNativeProperty(node, 'form') : null;
        if (isSubmitter && nativeForm === undefined) incompleteNativeIntent = true;
        const form = nativeForm as HTMLFormElement | null;
        let formAction: string | null = null;
        let formFields: Array<{ name: string; value: string }> = [];
        if (form) {
          const actionOverride = (isButton || isInput) && readAttribute(node, 'formaction') !== null;
          const methodOverride = (isButton || isInput) && readAttribute(node, 'formmethod') !== null;
          const action = getNativeProperty(actionOverride ? node : form, actionOverride ? 'formAction' : 'action');
          const method = getNativeProperty(methodOverride ? node : form, methodOverride ? 'formMethod' : 'method');
          if (typeof action !== 'string' || typeof method !== 'string') incompleteNativeIntent = true;
          else {
            formAction = action;
            const collectedFields = fieldsFor(form, method);
            if (!collectedFields) incompleteNativeIntent = true;
            else formFields = collectedFields;
          }
        }
        return {
          label: labelFor(node),
          href: readAttribute(node, 'href'),
          formAction,
          formFields,
          hasScriptHandlers: (node === element && hasUnverifiedDescendantHandlers)
            || (form ? hasFormScriptHandlers(form) : hasScriptHandlers(node)),
        };
      }),
    };
    if (incompleteNativeIntent) return null;
    return inspection;
  }

  const nativeActiveElement = getNativeProperty(document, 'activeElement');
  const active = (nativeActiveElement === undefined ? document.activeElement : nativeActiveElement) as Element | null;
  const form = active ? getNativeProperty(active, 'form') as HTMLFormElement | null | undefined : null;
  if (!form) return null;
  const formAction = getNativeProperty(form, 'action');
  const formMethod = getNativeProperty(form, 'method');
  const formElements = getNativeProperty(form, 'elements') as HTMLFormControlsCollection | undefined;
  if (typeof formAction !== 'string' || typeof formMethod !== 'string' || !formElements) return null;
  const formControls = arrayFrom(formElements);
  let incompleteSubmitterIntent = false;
  const submitters = arrayMap(arrayFilter(formControls, (candidate) => {
      const disabled = getNativeProperty(candidate, 'disabled');
      const type = getNativeProperty(candidate, 'type');
      if (isNativeInstance(candidate, 'HTMLButtonElement')) return type === 'submit' && disabled === false;
      return isNativeInstance(candidate, 'HTMLInputElement')
        && (type === 'submit' || type === 'image')
        && disabled === false;
    }), (candidate) => {
      const actionOverride = readAttribute(candidate, 'formaction') !== null;
      const nativeAction = actionOverride ? getNativeProperty(candidate, 'formAction') : formAction;
      if (typeof nativeAction !== 'string') incompleteSubmitterIntent = true;
      return {
        label: labelFor(candidate),
        formAction: typeof nativeAction === 'string' ? nativeAction : '',
        hasScriptHandlers: hasScriptHandlers(candidate),
      };
    });
  const hasGetSubmitter = arraySome(formControls, (candidate) => {
    const type = getNativeProperty(candidate, 'type');
    const isSubmitter = (isNativeInstance(candidate, 'HTMLButtonElement') && type === 'submit')
      || (isNativeInstance(candidate, 'HTMLInputElement') && (type === 'submit' || type === 'image'));
    return isSubmitter
    && getNativeProperty(candidate, 'disabled') === false
    && readAttribute(candidate, 'formmethod') !== null
    && typeof getNativeProperty(candidate, 'formMethod') === 'string'
    && stringToLowerCase(getNativeProperty(candidate, 'formMethod') as string) === 'get';
  });
  for (let index = 0; index < formControls.length; index += 1) {
    const candidate = formControls[index];
    if (!candidate || !(isNativeInstance(candidate, 'HTMLButtonElement') || isNativeInstance(candidate, 'HTMLInputElement'))) continue;
    if (readAttribute(candidate, 'formmethod') !== null
      && typeof getNativeProperty(candidate, 'formMethod') !== 'string') incompleteSubmitterIntent = true;
  }
  const method = stringToLowerCase(formMethod);
  const fields = fieldsFor(form, hasGetSubmitter ? 'get' : method);
  if (!fields || incompleteSubmitterIntent) return null;
  return {
    kind: 'form',
    pageUrl,
    formAction,
    method,
    fields,
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
            || formAction !== null
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
        if (action.submit) {
          return { ok: false, action: 'fill_form', error: 'form submission is disabled by policy' };
        }
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
