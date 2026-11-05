// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { api } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { setLanguage } from '../src/i18n';
import { ThemeProvider } from '../src/lib/theme';
import { RegisterPage } from '../src/pages/RegisterPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function renderRegisterPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <ThemeProvider>
            <MemoryRouter initialEntries={['/register']}>
              <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/login" element={<h1>Sign in</h1>} />
              </Routes>
            </MemoryRouter>
          </ThemeProvider>
        </AuthProvider>
      </ToastProvider>
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
  setLanguage('en');
  vi.spyOn(api.auth, 'session').mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('public registration accessibility', () => {
  it('names all registration fields and the create-account action', async () => {
    vi.spyOn(api, 'config').mockResolvedValue({
      appName: 'Agent Tasks',
      allowRegistration: true,
      defaultTimezone: 'UTC',
      mailer: 'log',
      version: '0.1.0',
    });

    renderRegisterPage();

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeTruthy();
    expect(screen.getByLabelText(/^Password/i)).toBeTruthy();
    expect(screen.getByLabelText(/^Confirm password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces config failures and retries before revealing registration', async () => {
    const config = vi.spyOn(api, 'config')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        appName: 'Agent Tasks',
        allowRegistration: true,
        defaultTimezone: 'UTC',
        mailer: 'log',
        version: '0.1.0',
      });

    renderRegisterPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeTruthy();
    expect(config).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('shows one sign-in action when registration is disabled', async () => {
    vi.spyOn(api, 'config').mockResolvedValue({
      appName: 'Agent Tasks',
      allowRegistration: false,
      defaultTimezone: 'UTC',
      mailer: 'log',
      version: '0.1.0',
    });

    renderRegisterPage();

    expect(await screen.findByRole('heading', { name: /registration is disabled/i })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Back to sign in' })).toHaveLength(1);
    expectInteractiveControlsNamed();
  });

  it('announces rejected sign-ups and confirms when verification email is sent', async () => {
    vi.spyOn(api, 'config').mockResolvedValue({
      appName: 'Agent Tasks',
      allowRegistration: true,
      defaultTimezone: 'UTC',
      mailer: 'log',
      version: '0.1.0',
    });
    const signUp = vi.spyOn(api.auth, 'signUp')
      .mockRejectedValueOnce(new Error('Registration service unavailable'))
      .mockResolvedValueOnce({});

    renderRegisterPage();
    await screen.findByRole('heading', { name: 'Create your account' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New User' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'new-user@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/i), { target: { value: 'safe-test-password-123' } });
    fireEvent.change(screen.getByLabelText(/^Confirm password/i), { target: { value: 'safe-test-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Registration service unavailable');
    expectInteractiveControlsNamed();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect((await screen.findByRole('status')).textContent).toContain('new-user@example.test');
    expect(signUp).toHaveBeenCalledTimes(2);
    expect(signUp).toHaveBeenLastCalledWith({
      name: 'New User',
      email: 'new-user@example.test',
      password: 'safe-test-password-123',
    });
    expectInteractiveControlsNamed();
  });
});
