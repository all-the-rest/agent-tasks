// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider } from '../src/lib/theme';
import { ToastProvider } from '../src/components/ui';
import { SettingsPage } from '../src/pages/SettingsPage';
import { setLanguage } from '../src/i18n';
import type { SessionUser } from '../src/lib/types';

const baseUser: SessionUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'USER',
  twoFactorEnabled: false,
};

let twoFactorEnabled: boolean;
let calls: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function currentUser(): SessionUser {
  return { ...baseUser, twoFactorEnabled };
}

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url}`);

  if (url.endsWith('/api/auth/get-session')) {
    return Promise.resolve(
      json({
        user: currentUser(),
        session: { id: 'session-1', expiresAt: '2099-01-01T00:00:00.000Z' },
      }),
    );
  }
  if (url.endsWith('/api/me')) {
    return Promise.resolve(
      json({
        user: { ...currentUser(), emailVerified: true },
        preferences: { timezone: 'UTC', locale: 'en', theme: 'system' },
        limits: { maxConcurrentExecutionsPerUser: 2, maxTaskExecutionsPerDay: 20 },
      }),
    );
  }
  if (url.endsWith('/api/providers')) return Promise.resolve(json([]));
  if (url.endsWith('/api/auth/two-factor/enable') && method === 'POST') {
    return Promise.resolve(
      json({
        method: 'totp',
        totpURI: 'otpauth://totp/Agent%20Tasks:user@example.com?secret=ABC123&issuer=Agent%20Tasks',
        backupCodes: ['AAAAA-11111', 'BBBBB-22222'],
      }),
    );
  }
  if (url.endsWith('/api/auth/two-factor/verify-totp') && method === 'POST') {
    twoFactorEnabled = true;
    return Promise.resolve(json({ token: 'session-token', user: currentUser() }));
  }
  if (url.endsWith('/api/auth/two-factor/disable') && method === 'POST') {
    twoFactorEnabled = false;
    return Promise.resolve(json({ status: true }));
  }
  return Promise.resolve(json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404));
});

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <SettingsPage />
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
  twoFactorEnabled = false;
  calls = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settings two-factor section', () => {
  it('shows the TOTP URI and backup codes returned by the enable endpoint', async () => {
    renderSettings();
    const browser = userEvent.setup({ delay: null });

    await browser.type(await screen.findByLabelText(/current password/i), 'correct horse battery staple');
    await browser.click(screen.getByRole('button', { name: 'Enable two-factor authentication' }));

    expect((await screen.findByTestId('mfa-totp-uri')).textContent).toContain('otpauth://totp/');
    const codes = screen.getByTestId('mfa-backup-codes');
    expect(within(codes).getAllByRole('listitem')).toHaveLength(2);
    expect(codes.textContent).toContain('AAAAA-11111');

    await browser.type(screen.getByLabelText(/authenticator or backup code/i), '123456');
    await browser.click(screen.getByRole('button', { name: 'Confirm and enable' }));

    expect(
      await screen.findByRole('button', { name: 'Disable two-factor authentication' }),
    ).toBeTruthy();
    expect(calls).toContain('POST /api/auth/two-factor/verify-totp');
  }, 15_000);

  it('validates the code before calling the disable endpoint', async () => {
    twoFactorEnabled = true;
    renderSettings();
    const browser = userEvent.setup({ delay: null });

    await browser.click(
      await screen.findByRole('button', { name: 'Disable two-factor authentication' }),
    );
    const dialog = screen.getByRole('dialog');
    await browser.type(within(dialog).getByLabelText(/current password/i), 'correct horse battery staple');
    await browser.type(within(dialog).getByLabelText(/authenticator or backup code/i), '654321');
    await browser.click(
      within(dialog).getByRole('button', { name: 'Disable two-factor authentication' }),
    );

    await waitFor(() => {
      expect(calls).toContain('POST /api/auth/two-factor/disable');
    });
    const verifyIndex = calls.indexOf('POST /api/auth/two-factor/verify-totp');
    const disableIndex = calls.indexOf('POST /api/auth/two-factor/disable');
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeLessThan(disableIndex);
    expect(twoFactorEnabled).toBe(false);
  }, 15_000);
});
