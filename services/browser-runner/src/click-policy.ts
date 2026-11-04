/**
 * Policy helpers for the browser actions that may not be automated.
 *
 * These are deliberately small, pure and unit-tested: the browser runner refuses
 * to log in, pay, submit orders or delete data, and that refusal must not depend
 * on the model's phrasing. Matching runs on whole tokens (lowercase, no
 * punctuation, collapsed whitespace) so "Sign-in", "SIGN IN!" and "Sign in now"
 * all match while unrelated words such as "signpost", "logistics", "authors" or
 * "accounting" never match by substring. Where a label is ambiguous the policy
 * fails closed: "Login history" is refused rather than risk automating a login.
 */

/** Lowercases and strips punctuation so "Log in!", "LOG-IN" and "login" compare equal. */
export function normalizeControlText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Splits a control label or route segment into whole words. */
function tokenize(value: string): string[] {
  const normalized = normalizeControlText(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** True when `phrase` occurs in `tokens` as a contiguous run of whole tokens. */
function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[start + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Multi-token phrases keep "sign in" distinct from "signpost"; single tokens are
 * matched as whole words, so "deleted", "registering" and "logistics" do not hit.
 * Plurals and inflections that appear on real controls are listed explicitly.
 */
const FORBIDDEN_CLICK_PHRASES: readonly (readonly string[])[] = [
  // Authentication.
  ['log', 'in'],
  ['login'],
  ['log', 'out'],
  ['logout'],
  ['log', 'off'],
  ['logoff'],
  ['sign', 'in'],
  ['signin'],
  ['sign', 'out'],
  ['signout'],
  ['sign', 'off'],
  ['signoff'],
  ['sign', 'up'],
  ['signup'],
  ['register'],
  ['registration'],
  ['create', 'account'],
  ['open', 'account'],
  // Payment, checkout and ordering.
  ['checkout'],
  ['check', 'out'],
  ['pay'],
  ['payment'],
  ['payments'],
  ['purchase'],
  ['purchases'],
  ['buy'],
  ['order'],
  ['orders'],
  ['place', 'order'],
  ['submit', 'order'],
  ['complete', 'order'],
  ['confirm', 'order'],
  // Destructive account actions.
  ['delete'],
  ['erase'],
  ['destroy'],
  ['wipe'],
  ['remove'],
  ['deactivate'],
  ['delete', 'account'],
  ['remove', 'account'],
  ['close', 'account'],
  ['close', 'my', 'account'],
  ['unsubscribe'],
  ['erase', 'account'],
  ['destroy', 'account'],
  ['destroy', 'all', 'data'],
  ['wipe', 'data'],
  ['cancel', 'subscription'],
  ['cancel', 'subscriptions'],
  ['cancel', 'my', 'subscription'],
  ['cancel', 'my', 'subscriptions'],
  ['cancel', 'plan'],
  ['cancel', 'my', 'plan'],
  ['subscribe'],
  ['start', 'subscription'],
  ['start', 'a', 'subscription'],
  ['start', 'my', 'subscription'],
  ['start', 'your', 'subscription'],
  ['begin', 'subscription'],
  ['begin', 'a', 'subscription'],
  ['begin', 'my', 'subscription'],
  ['begin', 'your', 'subscription'],
  ['cancel', 'membership'],
  ['disable', 'account'],
  ['create', 'an', 'account'],
  ['kündigen'],
  ['kuendigen'],
  ['abo', 'starten'],
  ['abonnement', 'starten'],
  ['abo', 'abschließen'],
  ['abo', 'abschliessen'],
  ['abonnement', 'abschließen'],
  ['abonnement', 'abschliessen'],
  ['abo', 'kündigen'],
  ['abo', 'kuendigen'],
  ['abonnement', 'kündigen'],
  ['abonnement', 'kuendigen'],
  ['mitgliedschaft', 'kündigen'],
  ['vertrag', 'kündigen'],
  // German equivalents (umlauts kept, transliterations included).
  ['anmelden'],
  ['anmeldung'],
  ['einloggen'],
  ['ausloggen'],
  ['abmelden'],
  ['abmeldung'],
  ['registrieren'],
  ['registrierung'],
  ['kaufen'],
  ['bezahlen'],
  ['zahlung'],
  ['zahlungen'],
  ['zahlungspflichtig', 'bestellen'],
  ['bestellen'],
  ['bestellung'],
  ['bestellungen'],
  ['kasse'],
  ['zur', 'kasse'],
  ['löschen'],
  ['loeschen'],
  ['entfernen'],
  ['konto', 'löschen'],
  ['konto', 'loeschen'],
  ['konto', 'entfernen'],
  ['konto', 'schließen'],
  ['konto', 'schliessen'],
  ['konto', 'erstellen'],
  ['konto', 'anlegen'],
  ['konto', 'deaktivieren'],
  ['abbestellen'],
];

/** True when clicking this control would authenticate, pay, order or destroy data. */
export function isForbiddenClickTarget(
  label: string,
  context: { href?: string | null; formAction?: string | null; pageUrl?: string } = {},
): boolean {
  const tokens = tokenize(label);
  if (tokens.length > 0 && FORBIDDEN_CLICK_PHRASES.some((phrase) => containsPhrase(tokens, phrase))) return true;

  // A bland label such as "Continue" must not bypass policy when the click itself
  // would navigate into checkout, authentication, payment or account controls.
  // Non-web schemes can execute code or launch external applications, so they
  // are uninspectable and fail closed as well.
  const clickUrls: string[] = [];
  const addWebUrl = (rawUrl: string): boolean => {
    try {
      const url = new URL(rawUrl, context.pageUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      clickUrls.push(url.toString());
      return true;
    } catch {
      return false;
    }
  };
  if (context.href && !addWebUrl(context.href)) return true;
  if (context.formAction && !addWebUrl(context.formAction)) return true;
  if (context.pageUrl) clickUrls.push(context.pageUrl);
  return clickUrls.some((url) => isForbiddenClickUrl(url));
}

/**
 * Route words that mean a form submission would authenticate, pay or touch an
 * account. Whole-word matching (not substrings) keeps "authors", "accounting"
 * and "catalogue" out, while joined segments such as "sign-in" still resolve.
 */
const FORBIDDEN_FORM_ROUTE_WORDS = new Set([
  'auth',
  'authenticate',
  'authentication',
  'authorize',
  'authorization',
  'oauth',
  'oauth2',
  'login',
  'logout',
  'logoff',
  'signin',
  'signout',
  'signoff',
  'signup',
  'register',
  'registration',
  'account',
  'accounts',
  'checkout',
  'payment',
  'payments',
  'pay',
  'billing',
  'subscribe',
  'subscription',
  'subscriptions',
  'abo',
  'abos',
  'abonnement',
  'abonnements',
  'purchase',
  'purchases',
  'order',
  'orders',
  'anmelden',
  'anmeldung',
  'einloggen',
  'ausloggen',
  'registrieren',
  'registrierung',
  'kasse',
  'zahlung',
  'zahlungen',
  'bezahlen',
  'kaufen',
  'bestellen',
  'bestellung',
  'konto',
  'konten',
  'delete',
  'erase',
  'destroy',
  'wipe',
  'remove',
  'deactivate',
  'disable',
  'close',
  'cancel',
  'unsubscribe',
  'löschen',
  'loeschen',
  'entfernen',
  'deaktivieren',
  'schließen',
  'schliessen',
  'abbestellen',
  'abmelden',
  'abmeldung',
  'kündigen',
  'kuendigen',
]);

const SAFE_QUERY_PARAM_KEYS = new Set([
  'callback',
  'callbackurl',
  'continue',
  'next',
  'redirect',
  'redirectto',
  'redirecturl',
  'return',
  'returnto',
  'returnurl',
  'q',
  'query',
  'search',
  'term',
  'keyword',
]);

const REDIRECT_QUERY_PARAM_KEYS = new Set([
  'callback',
  'callbackurl',
  'continue',
  'next',
  'redirect',
  'redirectto',
  'redirecturl',
  'return',
  'returnto',
  'returnurl',
]);

/** Every lookup key a path segment or host label can contribute. */
function routeKeys(value: string): string[] {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes stay as-is; tokenizing still yields something checkable.
  }
  const tokens = tokenize(decoded);
  if (tokens.length === 0) return [];
  // "sign-in" yields ["sign", "in"]; the joined form catches the compound.
  return [tokens.join(''), ...tokens];
}

function queryRouteKeys(searchParams: URLSearchParams): string[] {
  return [...searchParams.entries()].flatMap(([key, value]) => {
    const parameterKeys = routeKeys(key);
    const normalizedKey = normalizeControlText(key).replaceAll(' ', '');
    return SAFE_QUERY_PARAM_KEYS.has(normalizedKey) ? parameterKeys : [...parameterKeys, ...routeKeys(value)];
  });
}

/**
 * True when submitting a form on this page would authenticate, pay or touch an
 * account. Query values are inspected unless the parameter is clearly a redirect
 * or search term; unknown keys fail closed rather than hiding an action route.
 */
export function isForbiddenFormUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const keys = [
    ...url.pathname.split('/').flatMap((segment) => routeKeys(segment)),
    ...routeKeys(url.hostname),
    ...queryRouteKeys(url.searchParams),
  ];
  const fragment = url.hash.slice(1).replace(/^!/, '');
  const fragmentPath = fragment.split('?')[0] ?? '';
  const normalizedFragment = normalizeControlText(fragmentPath).replaceAll(' ', '');
  if (fragmentPath.includes('/') || FORBIDDEN_FORM_ROUTE_WORDS.has(normalizedFragment)) {
    const fragmentUrl = new URL(fragment.startsWith('/') ? fragment : `/${fragment}`, url.origin);
    keys.push(...fragmentUrl.pathname.split('/').flatMap((segment) => routeKeys(segment)));
    keys.push(...queryRouteKeys(fragmentUrl.searchParams));
  }
  return keys.some((key) => FORBIDDEN_FORM_ROUTE_WORDS.has(key));
}

/** Follow redirect targets for clicks, while search terms remain ordinary text. */
function isForbiddenClickUrl(rawUrl: string, visited = new Set<string>(), depth = 0): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (isForbiddenFormUrl(rawUrl)) return true;
  if (depth >= 5) return true;

  const key = `${url.origin}${url.pathname}${url.search}`;
  if (visited.has(key)) return false;
  visited.add(key);

  for (const [param, value] of url.searchParams.entries()) {
    const normalizedParam = normalizeControlText(param).replaceAll(' ', '');
    if (!REDIRECT_QUERY_PARAM_KEYS.has(normalizedParam)) continue;
    if (isForbiddenClickUrl(new URL(value, url).toString(), visited, depth + 1)) return true;
  }
  return false;
}
