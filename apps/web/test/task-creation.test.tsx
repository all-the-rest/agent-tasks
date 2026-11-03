// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { setLanguage } from '../src/i18n';
import { api } from '../src/lib/api';
import { AuthProvider, RequireAuth, useAuth } from '../src/lib/auth';
import { resetTaskPromptDraftMemory, setTaskPromptDraftOwner, taskPromptDraftState } from '../src/lib/task-prompt-draft';
import type { SessionUser, Task } from '../src/lib/types';
import { TaskFormPage } from '../src/pages/TaskFormPage';
import { TasksPage } from '../src/pages/TasksPage';

const PROVIDER_ID = '123e4567-e89b-12d3-a456-426614174000';
const OWNER_1: SessionUser = { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'USER' };
const OWNER_2: SessionUser = { id: 'owner-2', email: 'other@example.test', name: 'Other', role: 'USER' };
let activeSessionUser: SessionUser | null = OWNER_1;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-created',
    ownerId: 'owner-1',
    title: 'A reviewed task',
    description: null,
    prompt: 'Research current developments and provide a concise report.',
    systemInstructions: null,
    providerId: PROVIDER_ID,
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
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    unreadCount: 0,
    ...overrides,
  };
}

function CurrentLocation() {
  const location = useLocation();
  return (
    <>
      <output data-testid="current-location">{location.pathname}{location.search}{location.hash}</output>
      <output data-testid="location-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function BrowserBackControl() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Simulate browser Back
    </button>
  );
}

function SwitchAccountControl() {
  const { refresh } = useAuth();
  return (
    <button
      type="button"
      onClick={async () => {
        activeSessionUser = OWNER_2;
        await refresh();
      }}
    >
      Switch to other account
    </button>
  );
}

function renderCreationFlow(initialEntries: Array<string | { pathname: string; state?: unknown }> = ['/tasks']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <ToastProvider>
            <Routes>
              <Route path="/login" element={<p>Signed out</p>} />
              <Route element={<RequireAuth><Outlet /></RequireAuth>}>
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/tasks/new" element={<TaskFormPage />} />
                <Route path="/tasks/:id" element={<p>Task details</p>} />
              </Route>
            </Routes>
            <CurrentLocation />
            <BrowserBackControl />
            <SwitchAccountControl />
          </ToastProvider>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderBrowserCreationFlow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ToastProvider>
            <Routes>
              <Route path="/login" element={<p>Signed out</p>} />
              <Route element={<RequireAuth><Outlet /></RequireAuth>}>
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/tasks/new" element={<TaskFormPage />} />
                <Route path="/tasks/:id" element={<p>Task details</p>} />
              </Route>
            </Routes>
            <CurrentLocation />
            <BrowserBackControl />
            <SwitchAccountControl />
          </ToastProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function mockCreationApi() {
  activeSessionUser = OWNER_1;
  vi.spyOn(api.auth, 'session').mockImplementation(async () => activeSessionUser
    ? { user: activeSessionUser, session: { id: `session-${activeSessionUser.id}`, expiresAt: '2026-12-31T00:00:00.000Z' } }
    : null);
  vi.spyOn(api.auth, 'signOut').mockResolvedValue(undefined);
  vi.spyOn(api.tasks, 'listPage').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'me').mockResolvedValue({
    user: { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'USER' },
    preferences: { timezone: 'UTC', locale: 'en', theme: 'system' },
    limits: { maxConcurrentExecutionsPerUser: 2, maxTaskExecutionsPerDay: 50 },
  });
  vi.spyOn(api.providers, 'list').mockResolvedValue([
    {
      id: PROVIDER_ID,
      name: 'Default provider',
      kind: 'openai-compatible',
      isDefault: true,
      hasCredential: true,
      hasPersonalCredential: false,
      models: [{ id: 'mock-model', label: 'Mock model', supportsTools: true, contextLength: 32_000 }],
    },
  ]);
  vi.spyOn(api, 'config').mockResolvedValue({
    appName: 'Agent Tasks',
    allowRegistration: false,
    defaultTimezone: 'UTC',
    scheduleTimePresets: { morning: '09:00', afternoon: '14:00', evening: '18:00', night: '22:00' },
    mailer: 'none',
    version: 'test',
  });
  return vi.spyOn(api.tasks, 'create').mockResolvedValue(makeTask());
}

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
  resetTaskPromptDraftMemory();
  window.history.replaceState(null, '', '/');
});

describe('prompt-first task creation', () => {
  it('carries the prompt into the review form and creates only after explicit confirmation', async () => {
    const createTask = mockCreationApi();
    const user = userEvent.setup({ delay: null });
    const prompt = 'Track new battery-recycling rules and summarize changes every week.';

    renderCreationFlow();
    const composer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    await user.type(composer, prompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));

    const reviewedPrompt = await screen.findByRole('textbox', { name: 'Prompt' });
    expect((reviewedPrompt as HTMLTextAreaElement).value).toBe(prompt);
    expect(screen.getByText(/Nothing is created until you confirm/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and create task' })).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks/new');
    expect(screen.getByTestId('current-location').textContent).not.toContain(prompt);

    await user.click(screen.getAllByRole('link', { name: 'Back to prompt' })[0]!);
    const restoredComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((restoredComposer as HTMLTextAreaElement).value).toBe(prompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Weekly battery rules');
    await user.click(screen.getByRole('button', { name: 'Review and create task' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ prompt })));
    expect(await screen.findByText('Task details')).toBeTruthy();

    // Simulate a fresh runtime to prove the cleared history entry—not only the
    // in-memory override—prevents a successful prompt from becoming stale.
    resetTaskPromptDraftMemory();
    await user.click(screen.getByRole('button', { name: 'Simulate browser Back' }));
    const freshComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((freshComposer as HTMLTextAreaElement).value).toBe('');
  });

  it('restores prompt edits when browser Back returns from the review form', async () => {
    const createTask = mockCreationApi();
    const user = userEvent.setup({ delay: null });
    const prompt = 'Track weekly changes to battery recycling rules.';
    const editedPrompt = 'Track weekly changes to battery recycling rules and list their effective dates.';

    renderCreationFlow();
    await user.type(await screen.findByRole('textbox', { name: 'What should this task do?' }), prompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));
    const reviewedPrompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.clear(reviewedPrompt);
    await user.type(reviewedPrompt, editedPrompt);

    expect(createTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Simulate browser Back' }));

    const restoredComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((restoredComposer as HTMLTextAreaElement).value).toBe(editedPrompt);
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks');
  });

  it('retains review edits in owner-scoped history state across a reload-style remount', async () => {
    mockCreationApi();
    const user = userEvent.setup({ delay: null });
    const prompt = 'Track weekly changes to battery recycling rules.';
    const editedPrompt = 'Track weekly changes to battery recycling rules and list effective dates. ';

    renderCreationFlow();
    await user.type(await screen.findByRole('textbox', { name: 'What should this task do?' }), prompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));
    const reviewedPrompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.clear(reviewedPrompt);
    await user.type(reviewedPrompt, editedPrompt);

    const currentState = JSON.parse(screen.getByTestId('location-state').textContent ?? 'null') as {
      taskPromptDraft: string;
      taskPromptDraftOwnerId: string;
    };
    expect(currentState).toEqual({ taskPromptDraft: editedPrompt, taskPromptDraftOwnerId: OWNER_1.id });
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks/new');
    expect(screen.getByTestId('current-location').textContent).not.toContain(editedPrompt);
    expect(window.localStorage.getItem('taskPromptDraft')).toBeNull();

    cleanup();
    resetTaskPromptDraftMemory();
    renderCreationFlow([{ pathname: '/tasks/new', state: currentState }]);

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe(editedPrompt);
  });

  it('restores edited prompt on browser Back after a genuine browser-history reload', async () => {
    mockCreationApi();
    const user = userEvent.setup({ delay: null });
    const prompt = 'Summarize weekly changes to battery recycling rules.';
    const editedPrompt = 'Summarize weekly changes and cite their effective dates.';
    window.history.replaceState(null, '', '/tasks');

    renderBrowserCreationFlow();
    await user.type(await screen.findByRole('textbox', { name: 'What should this task do?' }), prompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));
    const reviewedPrompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.clear(reviewedPrompt);
    await user.type(reviewedPrompt, editedPrompt);

    expect(screen.getByTestId('current-location').textContent).toBe('/tasks/new');
    cleanup();
    resetTaskPromptDraftMemory();
    setTaskPromptDraftOwner(null);
    renderBrowserCreationFlow();

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe(editedPrompt);
    await user.click(screen.getByRole('button', { name: 'Simulate browser Back' }));
    const restoredComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((restoredComposer as HTMLTextAreaElement).value).toBe(editedPrompt);
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks');
    expect(JSON.parse(screen.getByTestId('location-state').textContent ?? 'null')).toEqual(
      taskPromptDraftState(OWNER_1.id, editedPrompt),
    );
    expect(window.localStorage.getItem('taskPromptDraft')).toBeNull();
  });

  it('does not restore another account’s draft through review, Back history, or reload', async () => {
    mockCreationApi();
    const user = userEvent.setup({ delay: null });
    const privatePrompt = 'Owner one private prompt that must never cross accounts.';
    const revisedPrompt = `${privatePrompt} Add a private follow-up.`;

    renderCreationFlow();
    await user.type(await screen.findByRole('textbox', { name: 'What should this task do?' }), privatePrompt);
    await user.click(screen.getByRole('button', { name: 'Continue to task details' }));
    const reviewedPrompt = await screen.findByRole('textbox', { name: 'Prompt' });
    await user.clear(reviewedPrompt);
    await user.type(reviewedPrompt, revisedPrompt);

    await user.click(screen.getByRole('button', { name: 'Switch to other account' }));
    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText(/Nothing is created until you confirm/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Simulate browser Back' }));
    const otherAccountComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((otherAccountComposer as HTMLTextAreaElement).value).toBe('');
    const previousHistoryState = JSON.parse(screen.getByTestId('location-state').textContent ?? 'null') as unknown;

    cleanup();
    resetTaskPromptDraftMemory();
    renderCreationFlow([{ pathname: '/tasks', state: previousHistoryState }]);

    const reloadedComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((reloadedComposer as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks');
  });

  it('keeps the direct new-task form available without a prompt draft', async () => {
    mockCreationApi();
    renderCreationFlow(['/tasks/new']);

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Save task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review and create task' })).toBeNull();
  });

  it('localizes the prompt composer and its next-step action in German', async () => {
    mockCreationApi();
    setLanguage('de');
    const user = userEvent.setup({ delay: null });
    const prompt = 'Prüfe wöchentlich neue Regeln zum Batterierecycling.';
    renderCreationFlow();

    await user.type(await screen.findByRole('textbox', { name: 'Was soll diese Aufgabe erledigen?' }), prompt);
    await user.click(screen.getByRole('button', { name: 'Weiter zu den Aufgabendetails' }));

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe(prompt);
  });

  it('restores a history-state draft on form entry and localizes the review actions in German', async () => {
    mockCreationApi();
    setLanguage('de');
    const prompt = 'Fasse jede Woche neue Vorschriften zum Batterierecycling zusammen.';
    renderCreationFlow([{ pathname: '/tasks/new', state: taskPromptDraftState(OWNER_1.id, prompt) }]);

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe(prompt);
    expect(screen.getAllByRole('link', { name: 'Zurück zum Prompt' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Prüfen und Aufgabe anlegen' })).toBeTruthy();
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks/new');
    expect(screen.getByTestId('current-location').textContent).not.toContain(prompt);
  });
});
