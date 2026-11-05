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
import { SetupPage } from '../src/pages/SetupPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function renderSetupPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <ThemeProvider>
            <MemoryRouter initialEntries={['/setup']}>
              <Routes>
                <Route path="/setup" element={<SetupPage />} />
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
});

describe('first-admin setup accessibility smoke checks', () => {
  it('names each required setup field and the create action', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue({ configured: false });

    renderSetupPage();

    expect(await screen.findByLabelText(/setup token/i)).toBeTruthy();
    expect(screen.getByLabelText(/^name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create administrator' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces setup-status failures and provides a named retry', async () => {
    const setupStatus = vi.spyOn(api, 'setupStatus')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ configured: false });

    renderSetupPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Create administrator' })).toBeTruthy();
    expect(setupStatus).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('keeps the already-configured recovery link named', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue({ configured: true });

    renderSetupPage();

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Back to sign in' })).toHaveLength(1);
    expectInteractiveControlsNamed();
  });
});
