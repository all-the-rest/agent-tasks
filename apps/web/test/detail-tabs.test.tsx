// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    notification: 'none',
    memorySettings: { mode: 'auto', contextBytes: 12_000 },
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

function renderAt(path: string, route: string, element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
});

describe('task detail tabs', () => {
  function renderTaskDetail() {
    return renderAt('/tasks/task-active', '/tasks/:id', <TaskDetailPage />);
  }

  beforeEach(() => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask());
    vi.spyOn(api.tasks, 'executionsPage').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);
    vi.spyOn(api.recommendations, 'list').mockResolvedValue([]);
    vi.spyOn(api.recommendations, 'events').mockResolvedValue([]);
  });

  it('gives every tab a panel and exposes only the selected panel', async () => {
    renderTaskDetail();

    const overview = await screen.findByRole('tab', { name: 'Overview' });
    const memory = screen.getByRole('tab', { name: 'Memory' });
    const recommendations = screen.getByRole('tab', { name: 'Recommendations' });

    expect(overview.getAttribute('aria-selected')).toBe('true');
    for (const tab of [overview, memory, recommendations]) expectTabLinkage(tab);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Task details');
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
});
