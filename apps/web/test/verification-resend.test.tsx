// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider } from '../src/lib/theme';
import { LoginPage } from '../src/pages/LoginPage';
import { setLanguage } from '../src/i18n';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

/**
 * A public sign-up must verify its mailbox before a session exists. If the mail
 * is lost or the link expires, the login error is the only place the user can
 * ask for a fresh one. The page must offer that action, send the typed address to
 * Better Auth's generic endpoint, and never claim whether the account exists.
 */

let resendResponse: 'ok' | 'throttled';
let resendBody: Record<string, unknown> | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;

  if (url.endsWith('/api/auth/get-session')) return Promise.resolve(json(null));
  if (url.endsWith('/api/config')) {
    return Promise.resolve(
      json({
        appName: 'Agent Tasks',
        allowRegistration: true,
        defaultTimezone: 'UTC',
        mailer: 'log',
        version: '0.1.0',
      }),
    );
  }
  if (url.endsWith('/api/setup/status')) return Promise.resolve(json({ configured: true }));
  if (url.endsWith('/api/auth/sign-in/email') && method === 'POST') {
    return Promise.resolve(
      json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email is not verified' }, 403),
    );
  }
  if (url.endsWith('/api/auth/send-verification-email') && method === 'POST') {
    resendBody = body;
    if (resendResponse === 'throttled') {
      return Promise.resolve(json({ code: 'RATE_LIMITED', message: 'Too many requests' }, 429));
    }
    return Promise.resolve(json({ status: true }));
  }
  return Promise.resolve(json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404));
});

function renderLogin() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/login']}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function submitUnverifiedCredentials() {
  const browser = userEvent.setup({ delay: null });
  await screen.findByLabelText(/email/i);
  await browser.type(screen.getByLabelText(/email/i), 'unverified@example.com');
  await browser.type(screen.getByLabelText(/password/i), 'correct horse battery staple');
  await browser.click(screen.getByRole('button', { name: 'Sign in' }));
  return browser;
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
  resendResponse = 'ok';
  resendBody = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('verification email resend', () => {
  it('offers a resend action when sign-in reports an unverified address', async () => {
    renderLogin();
    await submitUnverifiedCredentials();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Verify your e-mail address first. Check your inbox for the link.',
    );
    expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('requests a fresh link for the typed address and shows a generic confirmation', async () => {
    renderLogin();
    const browser = await submitUnverifiedCredentials();

    await browser.click(await screen.findByRole('button', { name: 'Resend verification email' }));

    expect(resendBody).toEqual({ email: 'unverified@example.com' });
    expect((await screen.findByRole('status')).textContent).toContain(
      'If the address still needs verification, a new link is on its way. Check your inbox and spam folder.',
    );
    // The confirmation must not echo the address or imply that an account exists.
    expect(screen.queryByText('unverified@example.com')).toBeNull();
    expectInteractiveControlsNamed();
    const signInCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/auth/sign-in/email'),
    );
    expect(signInCalls).toHaveLength(1);
  });

  it('shows a non-enumerating throttle message without leaving the form', async () => {
    resendResponse = 'throttled';
    renderLogin();
    const browser = await submitUnverifiedCredentials();

    await browser.click(await screen.findByRole('button', { name: 'Resend verification email' }));

    const throttleMessage = await screen.findByText('Too many requests. Please wait a few minutes and try again.');
    expect(throttleMessage.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeTruthy();
    expectInteractiveControlsNamed();
    const resendCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/auth/send-verification-email'),
    );
    expect(resendCalls).toHaveLength(1);
  });
});
