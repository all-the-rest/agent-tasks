// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { api } from '../src/lib/api';
import type { Dashboard } from '../src/lib/types';
import { setLanguage } from '../src/i18n';
import { DashboardPage } from '../src/pages/DashboardPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

const dashboard: Dashboard = {
  activeTasks: [{
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Accessible dashboard task',
    enabled: true,
    nextRunAt: '2026-11-05T09:00:00.000Z',
    schedule: { preset: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
  }],
  pausedTasks: [],
  recentExecutions: [{
    id: '22222222-2222-4222-8222-222222222222',
    taskId: '11111111-1111-4111-8111-111111111111',
    taskTitle: 'Accessible dashboard task',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-11-04T09:00:00.000Z',
    finishedAt: '2026-11-04T09:00:02.000Z',
    durationMs: 2_000,
    error: null,
  }],
  failures: [],
};

function renderDashboardPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('dashboard accessibility smoke checks', () => {
  it('keeps empty dashboard navigation and create action named', async () => {
    vi.spyOn(api, 'dashboard').mockResolvedValue({
      activeTasks: [],
      pausedTasks: [],
      recentExecutions: [],
      failures: [],
    });

    renderDashboardPage();

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create your first task' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('keeps filled dashboard links, refresh and semantic table named', async () => {
    vi.spyOn(api, 'dashboard').mockResolvedValue(dashboard);

    renderDashboardPage();

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Accessible dashboard task' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces dashboard load errors and exposes a named retry', async () => {
    vi.spyOn(api, 'dashboard').mockRejectedValue(new Error('offline'));

    renderDashboardPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });
});
