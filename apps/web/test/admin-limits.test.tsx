// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { api } from '../src/lib/api';
import type { SystemSettings } from '../src/lib/types';
import { AdminPage } from '../src/pages/AdminPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

const configuredSettings: SystemSettings = {
  allowRegistration: false,
  defaultTimezone: 'UTC',
  maxConcurrentExecutionsPerUser: 2,
  maxTaskExecutionsPerDay: 50,
  agentLimits: {
    maxDurationSec: 600,
    maxAgentSteps: 12,
    maxPageVisits: 0,
    maxOutputBytes: 100_000,
    maxToolCalls: 24,
    maxSearchQueries: 4,
  },
  browserAllowHttp: true,
  browserAllowedPorts: [80, 443],
  searchProvider: 'searxng',
  searchBaseUrl: 'http://searxng:8080',
  scheduleTimePresets: { morning: '09:00', afternoon: '14:00', evening: '18:00', night: '22:00' },
};

function renderAdminPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin']}>
          <AdminPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('admin global per-run limits', () => {
  it('keeps global settings controls named when status metrics are empty', async () => {
    vi.spyOn(api.admin, 'settings').mockResolvedValue(configuredSettings);
    vi.spyOn(api.admin, 'metrics').mockResolvedValue({
      users: 0,
      tasks: 0,
      executionsLast24h: 0,
      active: 0,
      byStatus: {},
    });

    renderAdminPage();

    expect(await screen.findByLabelText('Default timezone')).toBeTruthy();
    expect(screen.getByLabelText('Maximum duration (seconds)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeTruthy();

    expectInteractiveControlsNamed();
  });

  it('announces an admin overview load failure accessibly', async () => {
    vi.spyOn(api.admin, 'settings').mockResolvedValue(configuredSettings);
    vi.spyOn(api.admin, 'metrics')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        users: 0,
        tasks: 0,
        executionsLast24h: 0,
        active: 0,
        byStatus: {},
      });

    renderAdminPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Default timezone')).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('loads and saves the configured budgets through system settings', async () => {
    const saveSettings = vi.spyOn(api.admin, 'saveSettings').mockResolvedValue(configuredSettings);
    vi.spyOn(api.admin, 'settings').mockResolvedValue(configuredSettings);
    vi.spyOn(api.admin, 'metrics').mockResolvedValue({
      users: 1,
      tasks: 2,
      executionsLast24h: 3,
      active: 0,
      byStatus: {},
    });

    renderAdminPage();
    const duration = await screen.findByLabelText('Maximum duration (seconds)');
    expect((duration as HTMLInputElement).value).toBe('600');
    expect((screen.getByLabelText('Maximum page visits') as HTMLInputElement).value).toBe('0');

    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      agentLimits: configuredSettings.agentLimits,
    }));
    expect(await screen.findAllByText('Settings saved.')).toHaveLength(2);
  });
});
