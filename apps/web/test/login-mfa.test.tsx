// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider } from '../src/lib/theme';
import { LoginPage } from '../src/pages/LoginPage';
import { setLanguage } from '../src/i18n';
import type { SessionUser } from '../src/lib/types';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

/**
 * Two-factor sign-in flow.
 *
 * Better Auth's `POST /sign-in/email` answers `{ twoFactorRedirect: true }`
 * instead of a session when TOTP is enabled. The page must not call `refresh()`
 * at that point (that is the old dead-end) but switch to the code step, then
 * verify with `/two-factor/verify-totp` (or `verify-backup-code`) and only then
 * refresh and navigate.
 */

const user: SessionUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'USER',
  twoFactorEnabled: true,
};

let sessionUser: SessionUser | null;
let signInBody: Record<string, unknown>;
let verifyStatus: 'ok' | 'invalid';
let verifyBody: Record<string, unknown>;
let configFailures: number;
let setupFailures: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;

  if (url.endsWith('/api/auth/get-session')) {
    return Promise.resolve(
      sessionUser
        ? json({ user: sessionUser, session: { id: 'session-1', expiresAt: '2099-01-01T00:00:00.000Z' } })
        : json(null),
    );
  }
  if (url.endsWith('/api/config')) {
    if (configFailures > 0) {
      configFailures -= 1;
      return Promise.resolve(json({ error: { code: 'unavailable', message: 'offline' } }, 503));
    }
    return Promise.resolve(
      json({ appName: 'Agent Tasks', allowRegistration: false, defaultTimezone: 'UTC', mailer: 'log', version: '0.1.0' }),
    );
  }
  if (url.endsWith('/api/setup/status')) {
    if (setupFailures > 0) {
      setupFailures -= 1;
      return Promise.resolve(json({ error: { code: 'unavailable', message: 'offline' } }, 503));
    }
    return Promise.resolve(json({ configured: true }));
  }
  if (url.endsWith('/api/auth/sign-in/email') && method === 'POST') {
    return Promise.resolve(json({ redirect: false, ...signInBody }));
  }
  if (
    method === 'POST' &&
    (url.endsWith('/api/auth/two-factor/verify-totp') || url.endsWith('/api/auth/two-factor/verify-backup-code'))
  ) {
    verifyBody = body ?? {};
    if (verifyStatus === 'invalid') {
      return Promise.resolve(json({ code: 'INVALID_CODE', message: 'Invalid code' }, 401));
    }
    sessionUser = user;
    return Promise.resolve(json({ token: 'session-token', user }));
  }
  return Promise.resolve(json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404));
});

function renderLogin(from = '/tasks') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={[{ pathname: '/login', state: { from } }]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/tasks" element={<div data-testid="tasks-page">tasks</div>} />
              <Route path="/" element={<div data-testid="home-page">home</div>} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function submitCredentials() {
  const browser = userEvent.setup({ delay: null });
  await screen.findByLabelText(/email/i);
  expectInteractiveControlsNamed();
  await browser.type(screen.getByLabelText(/email/i), 'user@example.com');
  await browser.type(screen.getByLabelText(/password/i), 'correct horse battery staple');
  await browser.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  // jsdom has no matchMedia; ThemeProvider consults it for the "system" theme.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  window.localStorage.clear();
  setLanguage('en');
  sessionUser = null;
  signInBody = { twoFactorRedirect: true, twoFactorMethods: ['totp'] };
  verifyStatus = 'ok';
  verifyBody = {};
  configFailures = 0;
  setupFailures = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('login two-factor flow', () => {
  it('announces configuration load failures and retries accessibly', async () => {
    configFailures = 1;
    renderLogin();

    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/config'))).toHaveLength(2);
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
  });

  it('announces setup-status load failures and retries accessibly', async () => {
    setupFailures = 1;
    renderLogin();

    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/status'))).toHaveLength(2);
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
  });

  it('switches to the code step instead of reporting a failed login', async () => {
    renderLogin();
    await submitCredentials();

    expect(await screen.findByLabelText(/authentication code/i)).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText(/email or password is incorrect/i)).toBeNull();
    expectInteractiveControlsNamed();
    // The old dead-end: refresh() after twoFactorRedirect, which has no session.
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/auth/get-session'))).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/get-session')),
    ).toHaveLength(1);
  });

  it('shows an error for an invalid code and stays on the code step', async () => {
    verifyStatus = 'invalid';
    renderLogin();
    await submitCredentials();

    const browser = userEvent.setup({ delay: null });
    await browser.type(await screen.findByLabelText(/authentication code/i), '000000');
    await browser.click(screen.getByRole('button', { name: 'Verify code' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That code is not valid. Try again.',
    );
    expect(screen.getByLabelText(/authentication code/i)).toBeTruthy();
    expect(screen.queryByTestId('tasks-page')).toBeNull();
  });

  it('verifies the code, refreshes the session and navigates to the original page', async () => {
    renderLogin('/tasks');
    await submitCredentials();

    const browser = userEvent.setup({ delay: null });
    await browser.type(await screen.findByLabelText(/authentication code/i), '123456');
    await browser.click(screen.getByRole('button', { name: 'Verify code' }));

    expect(await screen.findByTestId('tasks-page')).toBeTruthy();
    expect(verifyBody).toEqual({ code: '123456' });
    const sessionCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/auth/get-session'),
    );
    expect(sessionCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts a backup code through /two-factor/verify-backup-code', async () => {
    renderLogin();
    await submitCredentials();

    const browser = userEvent.setup({ delay: null });
    await browser.click(await screen.findByRole('button', { name: 'Use a backup code' }));
    await browser.type(await screen.findByLabelText(/backup code/i), 'abcde-12345');
    await browser.click(screen.getByRole('button', { name: 'Verify code' }));

    expect(await screen.findByTestId('tasks-page')).toBeTruthy();
    expect(verifyBody).toEqual({ code: 'abcde-12345' });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/auth/two-factor/verify-backup-code')),
    ).toBe(true);
  });
});
