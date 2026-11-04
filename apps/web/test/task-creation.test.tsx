// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { setLanguage } from '../src/i18n';
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { api } from '../src/lib/api';
import { AuthProvider, RequireAuth, useAuth } from '../src/lib/auth';
import { resetTaskPromptDraftMemory, setTaskPromptDraftOwner, taskPromptDraftState } from '../src/lib/task-prompt-draft';
import { TASK_SUGGESTION_IDS } from '../src/lib/task-suggestions';
import type { SessionUser, Task } from '../src/lib/types';
import { TaskFormPage } from '../src/pages/TaskFormPage';
import { TasksPage } from '../src/pages/TasksPage';

const PROVIDER_ID = '123e4567-e89b-12d3-a456-426614174000';
const OWNER_1: SessionUser = { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'USER' };
const OWNER_2: SessionUser = { id: 'owner-2', email: 'other@example.test', name: 'Other', role: 'USER' };
let activeSessionUser: SessionUser | null = OWNER_1;

type NamedFormRole = 'button' | 'checkbox' | 'combobox' | 'listbox' | 'radio' | 'searchbox' | 'slider' | 'spinbutton' | 'textbox';

function formControlRole(control: Element): NamedFormRole | null {
  if (control.tagName === 'BUTTON') return 'button';
  if (control.tagName === 'SELECT') return (control as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (control.tagName === 'TEXTAREA') return 'textbox';
  if (control.tagName !== 'INPUT') return null;

  switch ((control as HTMLInputElement).type) {
    case 'hidden':
      return null;
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'search':
      return 'searchbox';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'button':
    case 'image':
    case 'reset':
    case 'submit':
      return 'button';
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'time':
    case 'week':
      return null;
    default:
      return 'textbox';
  }
}

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
      executable: true,
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

  it('gives every form control a non-empty accessible name', async () => {
    mockCreationApi();
    const { container } = renderCreationFlow(['/tasks/new']);
    await screen.findByRole('textbox', { name: 'Prompt' });

    const controls = [...container.querySelectorAll('button, input, select, textarea')]
      .filter((control) => control.tagName !== 'INPUT' || (control as HTMLInputElement).type !== 'hidden');
    expect(controls.length).toBeGreaterThan(5);
    const roleCounts = new Map<NamedFormRole, number>();
    const rolelessControls: Element[] = [];
    for (const control of controls) {
      const role = formControlRole(control);
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      else rolelessControls.push(control);
    }
    for (const [role, count] of roleCounts) {
      expect(within(container).getAllByRole(role, { name: /\S/ })).toHaveLength(count);
    }
    const unnamedRoleless = rolelessControls.filter((control) => {
      const element = control as HTMLInputElement;
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      const labelledBy = element.getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => container.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      const labelText = Array.from(element.labels ?? []).map((label) => label.textContent?.trim() ?? '').join(' ').trim();
      return !(ariaLabel || labelledBy || labelText);
    });
    expect(unnamedRoleless.map((element) => `${element.tagName.toLowerCase()}#${element.id}`)).toEqual([]);
  });

  it('keeps the direct new-task form available without a prompt draft', async () => {
    mockCreationApi();
    renderCreationFlow(['/tasks/new']);

    expect((await screen.findByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Save task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review and create task' })).toBeNull();
  });

  it('offers only providers the worker can execute', async () => {
    mockCreationApi();
    vi.mocked(api.providers.list).mockResolvedValue([
      {
        id: PROVIDER_ID,
        name: 'Default provider',
        kind: 'openai-compatible',
        executable: true,
        isDefault: true,
        hasCredential: true,
        hasPersonalCredential: false,
        models: [{ id: 'mock-model', label: 'Mock model', supportsTools: true, contextLength: 32_000 }],
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174099',
        name: 'Legacy Ollama',
        kind: 'ollama',
        executable: false,
        isDefault: false,
        hasCredential: true,
        hasPersonalCredential: false,
        models: [],
      },
    ]);
    renderCreationFlow(['/tasks/new']);

    const providerSelect = await screen.findByRole('combobox', { name: 'Provider' });
    await waitFor(() => {
      expect(within(providerSelect).getAllByRole('option').map((option) => option.textContent)).toContain('Default provider');
    });
    const optionNames = within(providerSelect).getAllByRole('option').map((option) => option.textContent);
    expect(optionNames).not.toContain('Legacy Ollama');
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

  it('fills the composer from a suggested prompt without creating or running a task and keeps it owner-scoped', async () => {
    const createTask = mockCreationApi();
    vi.mocked(api.tasks.listPage).mockResolvedValue({ items: [makeTask()], nextCursor: null });
    const taskAction = vi.spyOn(api.tasks, 'action');
    const user = userEvent.setup({ delay: null });
    const suggestionId = TASK_SUGGESTION_IDS[0];
    const title = en.translation.tasks.suggestions[suggestionId].title;
    const prompt = en.translation.tasks.suggestions[suggestionId].prompt;

    renderCreationFlow();
    await user.click(await screen.findByRole('button', { name: `Use prompt: ${title}` }));

    const composer = screen.getByRole('textbox', { name: 'What should this task do?' }) as HTMLTextAreaElement;
    expect(composer.value).toBe(prompt);
    expect(composer).toBe(document.activeElement);
    expect(screen.getByTestId('current-location').textContent).toBe('/tasks');
    expect(JSON.parse(screen.getByTestId('location-state').textContent ?? 'null')).toEqual(
      taskPromptDraftState(OWNER_1.id, prompt),
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(taskAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Switch to other account' }));
    const otherAccountComposer = await screen.findByRole('textbox', { name: 'What should this task do?' });
    expect((otherAccountComposer as HTMLTextAreaElement).value).toBe('');
  });

  it('activates a suggestion from the keyboard and keeps the block collapsible', async () => {
    mockCreationApi();
    vi.mocked(api.tasks.listPage).mockResolvedValue({ items: [makeTask()], nextCursor: null });
    const user = userEvent.setup({ delay: null });
    const suggestionId = TASK_SUGGESTION_IDS[1];
    const title = en.translation.tasks.suggestions[suggestionId].title;
    const prompt = en.translation.tasks.suggestions[suggestionId].prompt;

    renderCreationFlow();
    const suggestionButton = await screen.findByRole('button', { name: `Use prompt: ${title}` });
    suggestionButton.focus();
    await user.keyboard('{Enter}');
    expect((screen.getByRole('textbox', { name: 'What should this task do?' }) as HTMLTextAreaElement).value).toBe(prompt);

    const hideSuggestions = screen.getByRole('button', { name: 'Hide suggestions' });
    expect(hideSuggestions.getAttribute('aria-expanded')).toBe('true');
    await user.click(hideSuggestions);
    expect(screen.queryByRole('button', { name: `Use prompt: ${title}` })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show suggestions' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('shows suggestions only on an active list that has tasks', async () => {
    mockCreationApi();
    vi.mocked(api.tasks.listPage).mockImplementation(async ({ status }) => ({
      items: status === 'paused' ? [] : [makeTask()],
      nextCursor: null,
    }));
    const user = userEvent.setup({ delay: null });

    renderCreationFlow();
    expect(await screen.findByRole('heading', { name: 'Suggested tasks' })).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'paused');
    expect(await screen.findByText('No tasks in this status')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Suggested tasks' })).toBeNull();

    cleanup();
    vi.mocked(api.tasks.listPage).mockResolvedValue({ items: [], nextCursor: null });
    renderCreationFlow();
    expect(await screen.findByText('No tasks in this status')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Suggested tasks' })).toBeNull();
  });

  it('localizes suggested prompts in German', async () => {
    mockCreationApi();
    vi.mocked(api.tasks.listPage).mockResolvedValue({ items: [makeTask()], nextCursor: null });
    setLanguage('de');
    const user = userEvent.setup({ delay: null });
    const suggestionId = TASK_SUGGESTION_IDS[2];
    const title = de.translation.tasks.suggestions[suggestionId].title;
    const prompt = de.translation.tasks.suggestions[suggestionId].prompt;

    renderCreationFlow();
    expect(await screen.findByRole('heading', { name: 'Vorgeschlagene Aufgaben' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: `Prompt übernehmen: ${title}` }));

    expect((screen.getByRole('textbox', { name: 'Was soll diese Aufgabe erledigen?' }) as HTMLTextAreaElement).value).toBe(prompt);
  });
});
