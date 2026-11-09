// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { setLanguage } from '../src/i18n';
import { api } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import type { ExecutionSummary, SessionUser, Task } from '../src/lib/types';
import { TaskDetailPage } from '../src/pages/TaskDetailPage';
import { TasksPage } from '../src/pages/TasksPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-active',
    ownerId: 'owner-1',
    title: 'Active task',
    description: null,
    prompt: 'Research current developments and provide a concise report.',
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
    unreadCount: 2,
    ...overrides,
  };
}

function renderTasks(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter>
            <ToastProvider>
              <TasksPage />
            </ToastProvider>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  };
}

function renderTaskDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tasks/task-active']}>
        <ToastProvider>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeExecution(id: string, readAt: string | null): ExecutionSummary & { createdAt: string } {
  return {
    id,
    taskId: 'task-active',
    taskTitle: 'Active task',
    status: 'completed',
    trigger: 'schedule',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    error: null,
    readAt,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  setLanguage('en');
  const owner: SessionUser = { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'USER' };
  vi.spyOn(api.auth, 'session').mockResolvedValue({
    user: owner,
    session: { id: 'session-owner-1', expiresAt: '2026-12-31T00:00:00.000Z' },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('scheduled-task inbox UI', () => {
  it('keeps the prompt composer, list filters, and task actions accessibly named', async () => {
    vi.spyOn(api.tasks, 'listPage').mockResolvedValue({ items: [makeTask()], nextCursor: null });

    renderTasks();

    expect(await screen.findByRole('textbox', { name: 'What should this task do?' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Filter by title' })).toBeTruthy();
    expectInteractiveControlsNamed();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue to task details' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Active task' })).toHaveLength(2);

    for (const role of ['button', 'checkbox', 'combobox', 'link', 'radio', 'switch', 'textbox']) {
      expect(screen.queryAllByRole(role, { name: '' }), `unnamed ${role} controls`).toHaveLength(0);
    }
  });

  it('announces task-list loading failures and provides a named retry action', async () => {
    vi.spyOn(api.tasks, 'listPage').mockRejectedValue(new Error('offline'));

    renderTasks();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces and retries a failed task-list refresh while keeping loaded tasks visible', async () => {
    let failNextRefresh = false;
    const listPage = vi.spyOn(api.tasks, 'listPage').mockImplementation(async () => {
      if (failNextRefresh) {
        throw new Error('offline');
      }
      return { items: [makeTask()], nextCursor: null };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(['tasks', 'active'], {
      pages: [{ items: [makeTask()], nextCursor: null }],
      pageParams: [null],
    });

    renderTasks(queryClient);

    expect(await screen.findAllByRole('link', { name: 'Active task' })).toHaveLength(2);
    const callsBeforeRefresh = listPage.mock.calls.length;
    failNextRefresh = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['tasks', 'active'], exact: true });
    });
    failNextRefresh = false;

    expect(listPage.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    expect(queryClient.getQueryState(['tasks', 'active'])?.status).toBe('error');
    expect(await screen.findByRole('alert')).toBeTruthy();
    const callsAfterFailedRefresh = listPage.mock.calls.length;
    expect(screen.getAllByRole('link', { name: 'Active task' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(listPage.mock.calls.length).toBeGreaterThan(callsAfterFailedRefresh);
  });

  it('retries a failed task-detail load accessibly', async () => {
    const getTask = vi.spyOn(api.tasks, 'get')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeTask());

    renderTaskDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Active task' })).toBeTruthy();
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it('requests active, paused and completed tasks when the status filter changes', async () => {
    const activeTask = makeTask();
    const pausedTask = makeTask({
      id: 'task-paused',
      title: 'Paused task',
      enabled: false,
      nextRunAt: null,
      status: 'paused',
      unreadCount: 0,
    });
    const completedTask = makeTask({
      id: 'task-completed',
      title: 'Completed task',
      enabled: false,
      completedAt: '2026-01-02T00:00:00.000Z',
      nextRunAt: null,
      status: 'completed',
      unreadCount: 0,
    });
    const listTasks = vi.spyOn(api.tasks, 'listPage').mockImplementation(async ({ status }) => {
      if (status === 'paused') return { items: [pausedTask], nextCursor: null };
      if (status === 'completed') return { items: [completedTask], nextCursor: null };
      return { items: [activeTask], nextCursor: null };
    });
    const user = userEvent.setup({ delay: null });

    renderTasks();
    expect(await screen.findAllByRole('link', { name: 'Active task' })).toHaveLength(2);
    const statusFilter = screen.getByRole('combobox', { name: 'Filter by status' });

    await user.selectOptions(statusFilter, 'paused');
    expect(await screen.findAllByRole('link', { name: 'Paused task' })).toHaveLength(2);
    expect(listTasks).toHaveBeenLastCalledWith({ status: 'paused', cursor: undefined });

    const completedFilter = screen.getByRole('combobox', { name: 'Filter by status' });
    await user.selectOptions(completedFilter, 'completed');
    expect((completedFilter as HTMLSelectElement).value).toBe('completed');
    expect(await screen.findAllByRole('link', { name: 'Completed task' })).toHaveLength(2);
    expect(listTasks).toHaveBeenLastCalledWith({ status: 'completed', cursor: undefined });
  });

  it('localizes task status and unread counts and shows a relative next-run time', async () => {
    vi.spyOn(api.tasks, 'listPage').mockResolvedValue({ items: [makeTask()], nextCursor: 'next-tasks' });

    renderTasks();
    expect(await screen.findByText('Next run: in 3 days')).toBeTruthy();
    expect(screen.getByLabelText('2 unread runs')).toBeTruthy();
    expect(screen.getAllByText('2 unread runs')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Load more tasks' })).toBeTruthy();

    act(() => setLanguage('de'));
    expect(await screen.findByRole('combobox', { name: 'Nach Status filtern' })).toBeTruthy();
    expect(screen.getByText('Nächster Lauf: in 3 Tagen')).toBeTruthy();
    expect(screen.getByLabelText('2 ungelesene Läufe')).toBeTruthy();
    expect(screen.getAllByText('2 ungelesene Läufe')).toHaveLength(2);
    expect(screen.getAllByText('Aktiv', { selector: 'span' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Weitere Aufgaben laden' })).toBeTruthy();
  });

  it('shows a localized empty state when a selected status has no tasks', async () => {
    vi.spyOn(api.tasks, 'listPage').mockImplementation(async ({ status }) => ({
      items: status === 'completed' ? [] : [makeTask()],
      nextCursor: null,
    }));
    const user = userEvent.setup({ delay: null });

    act(() => setLanguage('de'));
    renderTasks();
    const statusFilter = await screen.findByRole('combobox', { name: 'Nach Status filtern' });
    await user.selectOptions(statusFilter, 'completed');

    expect(await screen.findByText('Keine Aufgaben mit diesem Status')).toBeTruthy();
  });

  it('loads tasks past the first 50-item page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeTask({
      id: `task-${index + 1}`,
      title: `Task ${index + 1}`,
      unreadCount: 0,
    }));
    const lastTask = makeTask({ id: 'task-51', title: 'Task 51', unreadCount: 0 });
    const listPage = vi.spyOn(api.tasks, 'listPage').mockImplementation(async ({ cursor }) =>
      cursor
        ? { items: [lastTask], nextCursor: null }
        : { items: firstPage, nextCursor: 'tasks-page-2' },
    );
    const user = userEvent.setup({ delay: null });

    renderTasks();
    expect(await screen.findAllByRole('link', { name: 'Task 50' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));

    expect(await screen.findAllByRole('link', { name: 'Task 51' })).toHaveLength(2);
    expect(listPage).toHaveBeenLastCalledWith({ status: 'active', cursor: 'tasks-page-2' });
  }, 15_000);

  it('loads task history past the first 20 runs and reveals an older unread run', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      makeExecution(`run-${String(index + 1).padStart(4, '0')}`, '2026-01-02T00:00:00.000Z'),
    );
    const unreadRun = makeExecution('run-0021', null);
    const executionsPage = vi.spyOn(api.tasks, 'executionsPage').mockImplementation(async (_id, { cursor }) =>
      cursor
        ? { items: [unreadRun], nextCursor: null }
        : { items: firstPage, nextCursor: 'executions-page-2' },
    );
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask());
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);
    const user = userEvent.setup({ delay: null });

    act(() => setLanguage('de'));
    renderTaskDetail();
    expect(await screen.findByRole('link', { name: 'run-0020' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Weitere Läufe laden' }));

    expect(await screen.findByRole('link', { name: 'run-0021' })).toBeTruthy();
    expect(screen.getByText('Ungelesen')).toBeTruthy();
    expect(executionsPage).toHaveBeenLastCalledWith('task-active', { cursor: 'executions-page-2' });
  });

  it('shows the change-only e-mail notification instead of "No notification"', async () => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask({ notification: { email: { enabled: true, when: 'on_change' } } }));
    vi.spyOn(api.tasks, 'executionsPage').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);

    renderTaskDetail();

    expect(await screen.findByText('Email me only when the report changes')).toBeTruthy();
    expect(screen.queryByText('No notification')).toBeNull();
  });

  it('shows private task-run pairs and submits a follow-up without changing task actions', async () => {
    const task = makeTask({ conversationMode: 'conversation' });
    vi.spyOn(api.tasks, 'get').mockResolvedValue(task);
    vi.spyOn(api.tasks, 'executionsPage').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api.tasks, 'conversation').mockResolvedValue({
      items: [{
        id: 'conversation-run-1',
        status: 'completed',
        trigger: 'schedule',
        input: 'Research public transport updates.',
        assistantOutput: 'The main update is a new route.',
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        error: null,
      }],
    });
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);
    const followUp = vi.spyOn(api.tasks, 'followUp').mockResolvedValue({ executionId: 'conversation-run-2' });
    const user = userEvent.setup({ delay: null });

    renderTaskDetail();

    expect(await screen.findByText('Research public transport updates.')).toBeTruthy();
    expect(screen.getByText('The main update is a new route.')).toBeTruthy();
    const composer = screen.getByRole('textbox', { name: 'Ask a follow-up' });
    await user.type(composer, 'Check whether the route is already operating.');
    await user.click(screen.getByRole('button', { name: 'Send follow-up' }));

    await waitFor(() => expect(followUp).toHaveBeenCalledWith('task-active', 'Check whether the route is already operating.'));
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });

  it('disables follow-ups while a task execution is active', async () => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(makeTask({ conversationMode: 'conversation' }));
    vi.spyOn(api.tasks, 'executionsPage').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api.tasks, 'conversation').mockResolvedValue({
      items: [{
        id: 'conversation-run-active',
        status: 'running',
        trigger: 'manual',
        input: 'The current request.',
        assistantOutput: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        error: null,
      }],
    });
    vi.spyOn(api.tasks, 'memorySuggestions').mockResolvedValue([]);
    vi.spyOn(api.tasks, 'memoryChanges').mockResolvedValue([]);

    renderTaskDetail();

    expect(await screen.findByText('A run is already queued or running for this task.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Send follow-up' })).toHaveProperty('disabled', true);
  });
});
