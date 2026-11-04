import { describe, expect, it } from 'vitest';
import { isForbiddenClickTarget, isForbiddenFormUrl, normalizeControlText } from '../src/click-policy.js';

describe('normalizeControlText', () => {
  it('lowercases and collapses punctuation and whitespace', () => {
    expect(normalizeControlText('  Sign-In!!  ')).toBe('sign in');
    expect(normalizeControlText('Löschen…')).toBe('löschen');
    expect(normalizeControlText('   ')).toBe('');
  });
});

describe('isForbiddenClickTarget', () => {
  it.each([
    'Log in',
    'Log out',
    'Logout',
    'Log off',
    'LOG IN',
    'Login',
    'Sign in',
    'Sign out',
    'Signout',
    'Sign-in',
    'Sign in now',
    'Sign up',
    'Sign-up!',
    'Signup',
    'Register',
    'Registration',
    'Create account',
    'Checkout',
    'Check out',
    'Pay',
    'Pay now',
    'Payment',
    'Purchase',
    'Buy now',
    'Order',
    'Place order',
    'Submit order',
    'Complete order',
    'Delete',
    'Delete account',
    'Erase account',
    'Destroy all data',
    'Wipe data',
    'Remove',
    'Remove account',
    'Close account',
    'Close my account',
    'Deactivate account',
    'Unsubscribe',
    'Subscribe',
    'Subscribe now',
    'Start subscription',
    'Start your subscription',
    'Cancel subscription',
    'Cancel my subscription',
    'Cancel plan',
  ])('refuses the English control %j', (label) => {
    expect(isForbiddenClickTarget(label)).toBe(true);
  });

  it.each([
    'Anmelden',
    'Abmelden',
    'Ausloggen',
    'Einloggen',
    'Registrieren',
    'Registrierung',
    'Jetzt registrieren',
    'Kaufen',
    'Jetzt kaufen',
    'Bezahlen',
    'Zahlung',
    'Bestellen',
    'Zahlungspflichtig bestellen',
    'Löschen',
    'Konto löschen',
    'Konto entfernen',
    'Konto erstellen',
    'Konto anlegen',
    'Konto deaktivieren',
    'Konto schließen',
    'Zur Kasse',
    'Abbestellen',
    'Abmelden',
    'Abo kündigen',
    'Abo starten',
    'Abonnement abschließen',
    'Abonnement abschliessen',
  ])('refuses the German control %j', (label) => {
    expect(isForbiddenClickTarget(label)).toBe(true);
  });

  it('matches whole words only, so unrelated labels pass', () => {
    expect(isForbiddenClickTarget('')).toBe(false);
    expect(isForbiddenClickTarget('   ')).toBe(false);
    expect(isForbiddenClickTarget('Catalogue')).toBe(false);
    expect(isForbiddenClickTarget('Logistics')).toBe(false);
    expect(isForbiddenClickTarget('Signpost')).toBe(false);
    expect(isForbiddenClickTarget('Account settings')).toBe(false);
    expect(isForbiddenClickTarget('Accounting')).toBe(false);
    expect(isForbiddenClickTarget('Authors')).toBe(false);
    expect(isForbiddenClickTarget('Registrar')).toBe(false);
    expect(isForbiddenClickTarget('Learn more')).toBe(false);
    expect(isForbiddenClickTarget('Continue')).toBe(false);
    expect(isForbiddenClickTarget('Read more')).toBe(false);
    expect(isForbiddenClickTarget('Cancel')).toBe(false);
  });

  it('blocks bland labels when their destination or current route is sensitive', () => {
    expect(isForbiddenClickTarget('Continue', { href: '/checkout', pageUrl: 'https://shop.example/products' })).toBe(true);
    expect(isForbiddenClickTarget('Next', { href: 'https://shop.example/payment/confirm' })).toBe(true);
    expect(isForbiddenClickTarget('Continue', { formAction: 'https://shop.example/checkout', pageUrl: 'https://shop.example/cart' })).toBe(true);
    expect(isForbiddenClickTarget('Continue', { pageUrl: 'https://example.com/sign-in' })).toBe(true);
    expect(isForbiddenClickTarget('Continue', { href: '/products', pageUrl: 'https://shop.example/products' })).toBe(false);
  });

  it('refuses executable and non-web click destinations', () => {
    expect(isForbiddenClickTarget('Continue', {
      href: 'javascript:document.forms[0].submit()',
      pageUrl: 'https://shop.example/contact',
    })).toBe(true);
    expect(isForbiddenClickTarget('Continue', {
      formAction: 'javascript:document.forms[0].submit()',
      pageUrl: 'https://shop.example/contact',
    })).toBe(true);
    expect(isForbiddenClickTarget('Continue', {
      href: 'data:text/html,<script>submit()</script>',
      pageUrl: 'https://shop.example/contact',
    })).toBe(true);
  });

  it('refuses non-web URLs reached through redirect parameters', () => {
    expect(isForbiddenClickTarget('Continue', {
      href: 'https://shop.example/redirect?next=javascript%3Adocument.forms%5B0%5D.submit%28%29',
      pageUrl: 'https://shop.example/contact',
    })).toBe(true);
  });

  it('follows redirect parameters for click targets but not search terms', () => {
    expect(isForbiddenClickTarget('Continue', {
      href: '/redirect?next=%2Fcheckout',
      pageUrl: 'https://shop.example/cart',
    })).toBe(true);
    expect(isForbiddenClickTarget('Continue', {
      href: '/search?q=checkout',
      pageUrl: 'https://shop.example/products',
    })).toBe(false);
  });

  it('checks all visible and accessibility label text together', () => {
    expect(isForbiddenClickTarget('Continue Delete')).toBe(true);
    expect(isForbiddenClickTarget('Proceed payment')).toBe(true);
  });

  it('is case, punctuation and whitespace insensitive', () => {
    expect(isForbiddenClickTarget('  sIgN   iN!! ')).toBe(true);
    expect(isForbiddenClickTarget('LOG-IN')).toBe(true);
    expect(isForbiddenClickTarget('LÖSCHEN…')).toBe(true);
    expect(isForbiddenClickTarget('Konto   löschen.')).toBe(true);
    expect(isForbiddenClickTarget('SIGN_UP')).toBe(true);
  });
});

describe('isForbiddenFormUrl', () => {
  it.each([
    'https://example.com/login',
    'https://example.com/login.php',
    'https://example.com/sign-in',
    'https://example.com/sign_in',
    'https://example.com/signup',
    'https://example.com/register',
    'https://example.com/auth/login',
    'https://example.com/oauth/callback',
    'https://example.com/checkout',
    'https://example.com/checkout/payment',
    'https://example.com/payment/confirm',
    'https://example.com/billing',
    'https://example.com/purchase',
    'https://example.com/orders/42',
    'https://example.com/account/settings',
    'https://example.com/my-account',
    'https://example.com/accounts',
    'https://example.com/logout',
    'https://example.com/log-out',
    'https://example.com/sign-out',
    'https://example.com/session/signoff',
    'https://example.com/ACCOUNT',
    'https://example.com/de/anmelden',
    'https://example.com/kasse',
    'https://example.com/zahlung',
    'https://example.com/konto/bearbeiten',
    'https://login.example.com/help',
    'https://checkout.example.com/cart',
  ])('refuses form submission on %s', (url) => {
    expect(isForbiddenFormUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'https://example.com/products',
    'https://example.com/authors',
    'https://example.com/authoring',
    'https://example.com/accounting',
    'https://example.com/catalogue',
    'https://example.com/registrar',
    'https://example.com/users/42',
    'https://example.com/search?q=login',
    'https://example.com/docs?next=/account#section-payment',
  ])('allows form submission on %s', (url) => {
    expect(isForbiddenFormUrl(url)).toBe(false);
  });

  it('decodes percent-encoded route segments before matching', () => {
    expect(isForbiddenFormUrl('https://example.com/log%69n')).toBe(true);
  });

  it('checks sensitive hash-router paths while allowing descriptive anchors', () => {
    expect(isForbiddenFormUrl('https://example.com/#/checkout')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/#/account/delete')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/#section-checkout')).toBe(false);
  });

  it('inspects action-like query routes without treating redirect parameters as actions', () => {
    expect(isForbiddenFormUrl('https://example.com/docs?redirect=https://example.com/login')).toBe(false);
    expect(isForbiddenFormUrl('https://example.com/submit?mode=checkout')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/submit?action=delete-account')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/submit?task=checkout')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/submit?do=delete')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/settings?action=erase')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/settings?operation=destroy')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/api/subscribe')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/api/vertrag-kuendigen')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/api/submit?action=kuendigen')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/search?q=kuendigen')).toBe(false);
    expect(isForbiddenFormUrl('https://example.com/api/abo/starten')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/api/abonnement/abschliessen')).toBe(true);
    expect(isForbiddenFormUrl('https://example.com/submit?mode=shipping')).toBe(false);
    expect(isForbiddenFormUrl('https://example.com/search?q=login')).toBe(false);
    expect(isForbiddenFormUrl('https://auth.example.com/docs')).toBe(true);
  });

  it('does not treat an unparseable value as a forbidden route', () => {
    expect(isForbiddenFormUrl('not a url')).toBe(false);
  });
});
