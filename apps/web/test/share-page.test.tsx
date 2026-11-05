// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { setLanguage } from '../src/i18n';
import { ApiError, api } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider } from '../src/lib/theme';
import type { Provider, SessionUser, Task, TaskShareSnapshot } from '../src/lib/types';
import { SharePage } from '../src/pages/SharePage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

const snapshot: TaskShareSnapshot = {
  title: 'Vienna transit monitor',
  prompt: 'Research public transport changes in Vienna and cite the sources you opened.',
  schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
  timezone: 'Europe/Vienna',
};

const owner: SessionUser = {
  id: 'owner-1',
  email: 'owner@example.test',
  name: 'Owner',
  role: 'USER',
};

function provider(): Provider {
  return {
    id: 'provider-1',
    name: 'Local provider',
    kind: 'openai-compatible',
    executable: true,
    isDefault: true,
    hasCredential: true,
    hasPersonalCredential: false,
    models: [{ id: 'local-model', label: 'Local model', supportsTools: true, contextLength: null }],
  };
}

function CopiedTask() {
  const { id = '' } = useParams();
  return <p>Copied task {id}</p>;
}

function renderShare() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/share/token-abc']}>
            <Routes>
              <Route path="/share/:token" element={<SharePage />} />
              <Route path="/tasks/:id" element={<CopiedTask />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('public share page', () => {
  it('shows the frozen definition and asks a signed-out visitor to sign in', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue(null);
    const get = vi.spyOn(api.shares, 'get').mockResolvedValue(snapshot);

    renderShare();

    expect(await screen.findByRole('heading', { name: 'Vienna transit monitor' })).toBeTruthy();
    expect(screen.getByText(snapshot.prompt)).toBeTruthy();
    expect(screen.getByText('Every day at 06:30 (Europe/Vienna)')).toBeTruthy();
    expect(screen.getByText('Europe/Vienna')).toBeTruthy();
    expect(screen.getByText(/Only the title, prompt, schedule and timezone are shared/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in to copy this task' }).getAttribute('href')).toBe('/login');
    expectInteractiveControlsNamed();
    expect(get).toHaveBeenCalledWith('token-abc');
  });

  it('applies no-referrer before the token can be sent as a Referer', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue(null);
    let policyAtFetch: string | null = null;
    vi.spyOn(api.shares, 'get').mockImplementation(async () => {
      policyAtFetch = document.querySelector('meta[name="referrer"]')?.getAttribute('content') ?? null;
      return snapshot;
    });

    renderShare();

    expect(await screen.findByRole('heading', { name: 'Vienna transit monitor' })).toBeTruthy();
    expect(policyAtFetch).toBe('no-referrer');
  });

  it('removes its referrer policy when the share page unmounts', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue(null);
    vi.spyOn(api.shares, 'get').mockResolvedValue(snapshot);

    const view = renderShare();

    expect(await screen.findByRole('heading', { name: 'Vienna transit monitor' })).toBeTruthy();
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    view.unmount();
    expect(document.querySelector('meta[name="referrer"]')).toBeNull();
  });

  it('adopts with the signed-in user’s selected provider and model', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue({
      user: owner,
      session: { id: 'session-owner', expiresAt: '2026-12-31T00:00:00.000Z' },
    });
    vi.spyOn(api.shares, 'get').mockResolvedValue(snapshot);
    vi.spyOn(api.providers, 'list').mockResolvedValue([provider()]);
    const adopt = vi
      .spyOn(api.shares, 'adopt')
      .mockResolvedValue({ id: 'copied-task-id', title: snapshot.title } as Task);
    const user = userEvent.setup({ delay: null });

    renderShare();

    expect(await screen.findByText('Copy to my tasks')).toBeTruthy();
    const copy = await screen.findByRole('button', { name: 'Copy task' });
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expectInteractiveControlsNamed();
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));
    await user.click(copy);

    await waitFor(() =>
      expect(adopt).toHaveBeenCalledWith('token-abc', {
        providerId: 'provider-1',
        model: 'local-model',
      }),
    );
    expect(await screen.findByText('Copied task copied-task-id')).toBeTruthy();
  });

  it('shows the unavailable state for a revoked or unknown link', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue(null);
    vi.spyOn(api.shares, 'get').mockRejectedValue(new ApiError(404, 'not_found', 'share not found'));

    renderShare();

    expect(await screen.findByText('This share link is unavailable or has been revoked.')).toBeTruthy();
    expect(screen.getByText('This share link is unavailable or has been revoked.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText(/Only the title, prompt, schedule and timezone are shared/)).toBeNull();
  });

  it('recovers from a transient share load error with its named retry action', async () => {
    vi.spyOn(api.auth, 'session').mockResolvedValue(null);
    const shareQuery = vi.spyOn(api.shares, 'get')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(snapshot);

    renderShare();

    expect(await screen.findByRole('alert')).toBeTruthy();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Vienna transit monitor' })).toBeTruthy();
    expect(shareQuery).toHaveBeenCalledTimes(2);
  });
});
