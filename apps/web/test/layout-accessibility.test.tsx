// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { Layout } from '../src/components/Layout';
import { setLanguage } from '../src/i18n';
import { api } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { ThemeProvider } from '../src/lib/theme';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function renderLayout(role: 'ADMIN' | 'USER' = 'ADMIN') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.auth, 'session').mockResolvedValue({
    user: {
      id: 'admin-1',
      email: 'admin@example.test',
      name: 'Review Admin',
      role,
      twoFactorEnabled: false,
    },
    session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/']}>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<h1>Dashboard content</h1>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLanguage('en');
  localStorage.setItem('agent-tasks.theme', 'light');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('agent-tasks.theme');
  setLanguage('en');
});

describe('authenticated app layout accessibility', () => {
  it('exposes named navigation, skip link and main landmarks', async () => {
    renderLayout();

    expect(await screen.findByRole('heading', { name: 'Dashboard content' })).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();

    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink.getAttribute('href')).toBe('#main-content');

    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = [
      ['Dashboard', '/'],
      ['Tasks', '/tasks'],
      ['Executions', '/executions'],
      ['Memory', '/memory'],
      ['Settings', '/settings'],
      ['Admin', '/admin'],
      ['Users', '/admin/users'],
      ['Providers', '/admin/providers'],
      ['Audit log', '/admin/audit'],
      ['Monitoring', '/admin/monitoring'],
    ];
    for (const [name, href] of links) {
      expect(within(navigation).getByRole('link', { name, exact: true }).getAttribute('href')).toBe(href);
    }

    expectInteractiveControlsNamed();
  });

  it('opens the mobile navigation with an announced state and closes it with Escape', async () => {
    const user = userEvent.setup({ delay: null });
    renderLayout();
    await screen.findByRole('heading', { name: 'Dashboard content' });

    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-controls')).toBe('app-drawer');

    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps standard-user navigation named and hides administrator-only links', async () => {
    renderLayout('USER');

    expect(await screen.findByRole('heading', { name: 'Dashboard content' })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const [name, href] of [
      ['Dashboard', '/'],
      ['Tasks', '/tasks'],
      ['Executions', '/executions'],
      ['Memory', '/memory'],
      ['Settings', '/settings'],
    ]) {
      expect(within(navigation).getByRole('link', { name, exact: true }).getAttribute('href')).toBe(href);
    }
    for (const name of ['Admin', 'Users', 'Providers', 'Audit log', 'Monitoring']) {
      expect(within(navigation).queryByRole('link', { name, exact: true })).toBeNull();
    }
    expectInteractiveControlsNamed();
  });
});
