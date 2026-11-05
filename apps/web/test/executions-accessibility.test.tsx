// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { api } from '../src/lib/api';
import type { ExecutionSummary } from '../src/lib/types';
import { setLanguage } from '../src/i18n';
import { ExecutionsPage } from '../src/pages/ExecutionsPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

const execution: ExecutionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  taskTitle: 'Accessibility execution',
  status: 'completed',
  trigger: 'manual',
  startedAt: '2026-11-04T09:00:00.000Z',
  finishedAt: '2026-11-04T09:00:02.000Z',
  durationMs: 2_000,
  error: null,
};

function renderExecutionsPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/executions']}>
        <ExecutionsPage />
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

describe('executions page accessibility smoke checks', () => {
  it('keeps the empty state, refresh and status filters named', async () => {
    vi.spyOn(api.executions, 'list').mockResolvedValue([]);

    renderExecutionsPage();

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('group')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('keeps execution links, status filters and table headers semantic when filled', async () => {
    vi.spyOn(api.executions, 'list').mockResolvedValue([execution]);

    renderExecutionsPage();

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByRole('link', { name: execution.taskTitle })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
    expectInteractiveControlsNamed();
  });

  it('announces execution load errors and exposes a named retry action', async () => {
    vi.spyOn(api.executions, 'list').mockRejectedValue(new Error('offline'));

    renderExecutionsPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });
});
