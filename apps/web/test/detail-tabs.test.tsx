// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { ToastProvider } from '../src/components/ui';
import { setLanguage } from '../src/i18n';
import { api } from '../src/lib/api';
import type { Execution, Task } from '../src/lib/types';
import { ExecutionDetailPage } from '../src/pages/ExecutionDetailPage';
import { MemoryPage } from '../src/pages/MemoryPage';
import { TaskDetailPage } from '../src/pages/TaskDetailPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-active',
    ownerId: 'owner-1',
    title: 'Active task',
    description: null,
    prompt: 'Research current developments.',
    systemInstructions: null,
    providerId: 'provider-1',
    model: 'mock-model',
    enabled: true,
    schedule: { preset: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
    endCondition: { type: 'never' },
    scheduledRunCount: 0,
    completedAt: null,
    timezone: 'UTC',
    allowWebResearch: false,
    notification: { email: { enabled: false, when: 'always' } },
    memorySettings: { mode: 'auto', contextBytes: 12_000 },
    conversationMode: 'standalone',
    nextRunAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    unreadCount: 0,
    ...overrides,
  };
}

function makeExecution(): Execution {
  return {
    id: 'execution-1',
    taskId: 'task-active',
    taskTitle: 'Active task',
    status: 'completed',
    trigger: 'schedule',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60_000,
    error: null,
    inputSnapshot: 'Research current developments.',
    ownerId: 'owner-1',
    providerId: 'provider-1',
    model: 'mock-model',
    report: { summary: 'Summary', markdown: '# Report', sources: [], uncertainty: [] },
    toolCalls: [],
    usage: null,
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderAt(
  path: string,
  route: string,
  element: ReactElement,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <ToastProvider>
            <Routes>
              <Route path={route} element={element} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** WAI-ARIA tabs: each tab controls an existing panel, and selection tracks visibility. */
function expectTabLinkage(tab: HTMLElement) {
  expect(tab.getAttribute('role')).toBe('tab');
  const panelId = tab.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  const panel = panelId ? document.getElementById(panelId) : null;
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('role')).toBe('tabpanel');
  expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);

  const selected = tab.getAttribute('aria-selected') === 'true';
  expect(selected).toBe(!panel?.hasAttribute('hidden'));
  if (selected) {
    expect(tab.getAttribute('tabindex')).toBe('0');
  } else {
    expect(tab.getAttribute('tabindex')).toBe('-1');
  }
  return panel;
}

beforeEach(() => {
  setLanguage('en');
  vi.spyOn(api.memory, 'stats').mockResolvedValue({ global: 0, task: 0, total: 0 });
  vi.spyOn(api.memory, 'list').mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('memory scope tabs', () => {
  function renderMemory() {
    return renderAt('/memory', '/memory', <MemoryPage />);
  }

  it('links both tabs to persistent panels and syncs selection with the scope', async () => {
    const user = userEvent.setup({ delay: null });
    renderMemory();

    const globalTab = await screen.findByRole('tab', { name: 'Global user memory' });
    const taskTab = screen.getByRole('tab', { name: 'Task memory' });
    expectInteractiveControlsNamed();

    expect(globalTab.getAttribute('aria-selected')).toBe('true');
    expect(taskTab.getAttribute('aria-selected')).toBe('false');

    const globalPanel = expectTabLinkage(globalTab);
    const taskPanel = expectTabLinkage(taskTab);
    expect(globalPanel?.hasAttribute('hidden')).toBe(false);
    expect(taskPanel?.hasAttribute('hidden')).toBe(true);

    await user.click(taskTab);
    expect(taskTab.getAttribute('aria-selected')).toBe('true');
    expect(globalTab.getAttribute('aria-selected')).toBe('false');
    expect(document.getElementById(taskPanel?.id ?? '')?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById(globalPanel?.id ?? '')?.hasAttribute('hidden')).toBe(true);
    expect(await screen.findByRole('heading', { name: 'All task memories' })).toBeTruthy();
  });

  it('gives the memory editor dialog a name and names every form control', async () => {
    const user = userEvent.setup({ delay: null });
    renderMemory();

    await user.click(await screen.findByRole('button', { name: 'Add memory' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(titleId ? document.getElementById(titleId)?.textContent?.trim() : '').toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toBeTruthy();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(2);

    for (const role of ['button', 'combobox', 'textbox'] as const) {
      expect(within(dialog).queryAllByRole(role, { name: '' }), `unnamed dialog ${role}`).toHaveLength(0);
    }
  });

  it('moves and activates tabs with arrow, Home and End keys', async () => {
    const user = userEvent.setup({ delay: null });
    renderMemory();

    const globalTab = await screen.findByRole('tab', { name: 'Global user memory' });
    const taskTab = screen.getByRole('tab', { name: 'Task memory' });

    globalTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(taskTab);
    expect(taskTab.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(globalTab);
    expect(globalTab.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(taskTab);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(globalTab);
    expect(globalTab.getAttribute('aria-selected')).toBe('true');
  });

  it('announces memory statistics load failures and retries them', async () => {
    const statsQuery = vi.spyOn(api.memory, 'stats')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ global: 2, task: 3, total: 5 });

    renderMemory();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(statsQuery).toHaveBeenCalledTimes(2);
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('announces memory-list load failures and retries the list query', async () => {
    const memoryQuery = vi.spyOn(api.memory, 'list')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 });

    renderMemory();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(memoryQuery).toHaveBeenCalledTimes(2);
  });
});

describe('task detail tabs', () => {
  function renderTaskDetail(queryClient?: QueryClient) {
    return renderAt('/tasks/task-active', '/tasks/:id', <TaskDetailPage />, queryClient);
  }

  beforeEach(() => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask());
    vi.spyOn(api.tasks, 'executionsPage').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);
    vi.spyOn(api.recommendations, 'list').mockResolvedValue([]);
    vi.spyOn(api.recommendations, 'events').mockResolvedValue([]);
  });

  it('announces task detail load failures and retries the query', async () => {
    const taskQuery = vi.spyOn(api.tasks, 'get')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeTask());

    renderTaskDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeTruthy();
    expect(taskQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('announces and retries a failed execution-history refresh while keeping loaded runs visible', async () => {
    let failNextRefresh = false;
    const executionsPage = vi.spyOn(api.tasks, 'executionsPage').mockImplementation(async () => {
      if (failNextRefresh) {
        throw new Error('offline');
      }
      return { items: [makeExecution()], nextCursor: null };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(['task-executions', 'task-active'], {
      pages: [{ items: [{ ...makeExecution(), id: 'run-cached' }], nextCursor: null }],
      pageParams: [null],
    });

    renderTaskDetail(queryClient);

    expect(await screen.findByRole('link', { name: 'run-cach' })).toBeTruthy();
    const callsBeforeRefresh = executionsPage.mock.calls.length;
    failNextRefresh = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['task-executions', 'task-active'], exact: true });
    });
    failNextRefresh = false;

    expect(executionsPage.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    expect(queryClient.getQueryState(['task-executions', 'task-active'])?.status).toBe('error');
    expect(await screen.findByRole('alert')).toBeTruthy();
    const callsAfterFailedRefresh = executionsPage.mock.calls.length;
    expect(screen.getByRole('link', { name: 'run-cach' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(executionsPage.mock.calls.length).toBeGreaterThan(callsAfterFailedRefresh);
  });

  it('gives every tab a panel and exposes only the selected panel', async () => {
    renderTaskDetail();

    const overview = await screen.findByRole('tab', { name: 'Overview' });
    const memory = screen.getByRole('tab', { name: 'Memory' });
    const recommendations = screen.getByRole('tab', { name: 'Recommendations' });

    expect(overview.getAttribute('aria-selected')).toBe('true');
    for (const tab of [overview, memory, recommendations]) expectTabLinkage(tab);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Task details');
    expectInteractiveControlsNamed();
  });

  it('switches panels with arrow keys and follows roving tabindex', async () => {
    const user = userEvent.setup({ delay: null });
    renderTaskDetail();

    const overview = await screen.findByRole('tab', { name: 'Overview' });
    const memory = screen.getByRole('tab', { name: 'Memory' });
    const recommendations = screen.getByRole('tab', { name: 'Recommendations' });

    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(memory);
    expect(memory.getAttribute('aria-selected')).toBe('true');
    expect(overview.getAttribute('tabindex')).toBe('-1');
    expect(memory.getAttribute('tabindex')).toBe('0');

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(recommendations);
    expect(recommendations.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Recommendations' })).toBeTruthy();

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(memory);
    expect(memory.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(recommendations);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(overview);
    expect(overview.getAttribute('aria-selected')).toBe('true');
  });

  it('announces memory change history failures and retries the query', async () => {
    const changesQuery = vi.spyOn(api.tasks, 'memoryChanges')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderTaskDetail();

    fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(changesQuery).toHaveBeenCalledTimes(2);
  });

  it('announces memory suggestion failures and retries the query', async () => {
    const suggestionsQuery = vi.spyOn(api.tasks, 'memorySuggestions')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderTaskDetail();

    fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(suggestionsQuery).toHaveBeenCalledTimes(2);
  });

  it('announces task execution history failures and retries the query', async () => {
    const executionsQuery = vi.spyOn(api.tasks, 'executionsPage')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    renderTaskDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(executionsQuery).toHaveBeenCalledTimes(2);
  });

  it('announces conversation history failures and retries before rendering the follow-up composer', async () => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask({ conversationMode: 'conversation' }));
    const conversationQuery = vi.spyOn(api.tasks, 'conversation')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [] });

    renderTaskDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(conversationQuery).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expectInteractiveControlsNamed();
  });

  it('announces recommendation history failures and retries the query', async () => {
    const eventsQuery = vi.spyOn(api.recommendations, 'events')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderTaskDetail();

    fireEvent.click(await screen.findByRole('tab', { name: 'Recommendations' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(eventsQuery).toHaveBeenCalledTimes(2);
  });

  it('announces recommendation list failures and retries the query', async () => {
    const recommendationsQuery = vi.spyOn(api.recommendations, 'list')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderTaskDetail();

    fireEvent.click(await screen.findByRole('tab', { name: 'Recommendations' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(recommendationsQuery).toHaveBeenCalledTimes(2);
  });
});

describe('execution detail tabs', () => {
  function renderExecutionDetail() {
    return renderAt('/executions/execution-1', '/executions/:id', <ExecutionDetailPage />);
  }

  beforeEach(() => {
    vi.spyOn(api.executions, 'get').mockResolvedValue(makeExecution());
    vi.spyOn(api.executions, 'memory').mockResolvedValue({
      changes: [],
      suggestions: [],
      recommendationEvents: [],
    });
  });

  it('keeps a panel for every tab so inactive aria-controls targets exist', async () => {
    renderExecutionDetail();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) expectTabLinkage(tab);
    expectInteractiveControlsNamed();

    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls') ?? ''));
    expect(new Set(panels.map((panel) => panel?.id)).size).toBe(4);
    expect(panels.filter((panel) => !panel?.hasAttribute('hidden'))).toHaveLength(1);
  });

  it('moves between report, timeline, sources and memory with the keyboard', async () => {
    const user = userEvent.setup({ delay: null });
    renderExecutionDetail();

    const [report, timeline, sources, memory] = await screen.findAllByRole('tab');
    expect(report?.getAttribute('aria-selected')).toBe('true');

    report?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(timeline);
    expect(timeline?.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(memory);
    expect(memory?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(memory?.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden')).toBe(false);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(report);
    expect(report?.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(memory);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(report);
    expect(sources?.getAttribute('aria-selected')).toBe('false');
  });

  it('announces execution memory failures once and retries the shared review query', async () => {
    const memoryQuery = vi.spyOn(api.executions, 'memory')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ changes: [], suggestions: [], recommendationEvents: [] });

    renderExecutionDetail();

    fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(memoryQuery).toHaveBeenCalledTimes(2);
  });
});
