/* eslint-disable no-undef -- standalone Node script run outside the bundler */
/**
 * Verify the environment bootstrap and the registration setting against a running
 * Compose stack. Exits non-zero on the first mismatch.
 *
 * Env: API_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD.
 */
const base = (process.env.API_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  process.exit(1);
}

let adminCookie = '';

/**
 * `session: 'admin'` always uses the preserved administrator session.
 * `session: 'none'` sends no cookie and does not capture one (open sign-ups would
 * otherwise replace the admin cookie with the new USER session).
 */
async function call(method, path, body, session = 'none') {
  const useCookie = session === 'admin' ? adminCookie : '';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(useCookie ? { cookie: useCookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (session === 'login' && setCookies.length > 0) {
    adminCookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function check(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL ${message}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  console.log(`PASS ${message}`);
}

const signUp = (email) =>
  call('POST', '/api/auth/sign-up/email', {
    email,
    password: 'registration-password-123',
    name: 'Open Registration',
  });

// 1. The env bootstrap created the admin, so setup is complete.
const status = await call('GET', '/api/setup/status');
check(status.status === 200 && status.json?.configured === true, 'setup/status is configured from ADMIN_EMAIL');

// 2. Registration is closed in the shipped production env.
const config = await call('GET', '/api/config');
check(config.json?.allowRegistration === false, 'allowRegistration is false by default');

// 3. No invitation, no account.
const blocked = await signUp('closed-registration@example.com');
check(blocked.status === 403, 'sign-up without invitation is refused (403)', blocked);

// 4. The env admin can sign in and is ADMIN.
const login = await call('POST', '/api/auth/sign-in/email', { email: adminEmail, password: adminPassword }, 'login');
check(login.status === 200, 'env admin can sign in', login);
const me = await call('GET', '/api/me', undefined, 'admin');
check(me.json?.user?.role === 'ADMIN', 'env admin has role ADMIN', me.json?.user?.role);

// 5. The OpenCode Go provider was seeded with a shared credential.
const providers = await call('GET', '/api/admin/providers', undefined, 'admin');
const go = Array.isArray(providers.json) ? providers.json.find((provider) => provider.name === 'OpenCode Go') : undefined;
check(Boolean(go), 'OpenCode Go provider exists');
check(go?.kind === 'openai-compatible', 'OpenCode Go uses the OpenAI-compatible adapter');
check(go?.sharedCredential === true, 'OpenCode Go has a shared credential');
check(
  String(go?.config?.baseUrl ?? '').includes('opencode.ai'),
  'OpenCode Go base URL is configured',
  go?.config?.baseUrl,
);

// 6. The setting is effective at runtime in both directions.
const opened = await call('PUT', '/api/admin/settings', { allowRegistration: true }, 'admin');
check(opened.status === 200, 'admin can enable open registration');
const accepted = await signUp('open-registration@example.com');
check(accepted.status === 200, 'open sign-up succeeds when enabled (200)', accepted);

const closed = await call('PUT', '/api/admin/settings', { allowRegistration: false }, 'admin');
check(closed.status === 200, 'admin can disable open registration');
const refused = await signUp('closed-again@example.com');
check(refused.status === 403, 'sign-up is refused again after disabling (403)', refused);

console.log('ENV_BOOTSTRAP_OK');
