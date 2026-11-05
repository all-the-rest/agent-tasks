// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { ThemeProvider } from '../src/lib/theme';
import { api } from '../src/lib/api';
import type { InvitationPreview } from '../src/lib/types';
import { setLanguage } from '../src/i18n';
import { InvitePage } from '../src/pages/InvitePage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

const invitation: InvitationPreview = {
  email: 'new-user@example.test',
  role: 'USER',
  expiresAt: '2026-11-11T09:00:00.000Z',
};

function renderInvitePage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <ThemeProvider>
            <MemoryRouter initialEntries={['/invite/valid-token']}>
              <Routes>
                <Route path="/invite/:token" element={<InvitePage />} />
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

describe('invitation page accessibility smoke checks', () => {
  it('names the account-creation fields and actions for a valid invitation', async () => {
    vi.spyOn(api, 'invitation').mockResolvedValue(invitation);

    renderInvitePage();

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByLabelText(/^Name/)).toBeTruthy();
    expect(screen.getByLabelText(/^Password/)).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces invitation load errors and retries before showing the form', async () => {
    const invitationQuery = vi.spyOn(api, 'invitation')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(invitation);

    renderInvitePage();

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Back to sign in' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/^Name/)).toBeTruthy();
    expect(invitationQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });
});
