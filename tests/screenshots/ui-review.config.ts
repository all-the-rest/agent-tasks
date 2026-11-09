import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

export type UiReviewState = 'filled' | 'empty';
export type UiReviewViewport = 'desktop' | 'mobile';
export type UiReviewAuth = 'guest' | 'admin' | 'user' | 'none';

export interface UiReviewSeedContext {
  page: Page;
  workerIndex: number;
  projectName: string;
}

export type UiReviewSeed = (context: UiReviewSeedContext) => Promise<Record<string, string>>;

export interface UiReviewClickStep {
  kind: 'click';
  scope: 'banner' | 'complementary' | 'main';
  role: 'link' | 'button';
  name?: string;
  nameFrom?: string;
  /** Optional href pattern; :param values are resolved from the seed result. */
  href?: string;
}

export interface UiReviewGotoStep {
  kind: 'goto';
  path: string;
  reason: string;
}

export type UiReviewNavStep = UiReviewClickStep | UiReviewGotoStep;

export type UiReviewPrepareStep =
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'select'; selector: string; value?: string; valueFrom?: string };

export interface UiReviewRoute {
  name: string;
  /** Route pattern; dynamic :params are resolved from the state seed. */
  path: string;
  states: UiReviewState[];
  auth?: UiReviewAuth;
  viewports?: UiReviewViewport[];
  note?: string;
  seeds?: Partial<Record<UiReviewState, UiReviewSeed>>;
  nav?: UiReviewNavStep[];
  /** UI-only changes made before capture; these are never submitted. */
  prepare?: Partial<Record<UiReviewState, UiReviewPrepareStep[]>>;
}

export interface UiReviewConfig {
  outputDir: string;
  expectedTitle: string;
  routes: UiReviewRoute[];
}

interface ApiProvider {
  id: string;
  name: string;
  kind: string;
  providerId?: string;
}

interface ApiTask {
  id: string;
  title: string;
  providerId: string;
}

interface ProviderFixture {
  id: string;
  modelId: string;
}

interface TaskFixture extends ProviderFixture {
  taskId: string;
  taskTitle: string;
}

interface ExecutionFixture extends TaskFixture {
  executionId: string;
}

const MOCK_MODEL_ID = 'ui-review-mock-model';
const MOCK_PROVIDER_BASE_URL = 'http://ui-review-mock:1/v1';
const MOCK_CREDENTIAL_LABEL = 'ui-review-screenshots';
const providerCache = new Map<string, Promise<ProviderFixture>>();
const taskCache = new Map<string, Promise<TaskFixture>>();
const executionCache = new Map<string, Promise<ExecutionFixture>>();

function workerScope(context: UiReviewSeedContext): string {
  const project = context.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${project}-worker-${context.workerIndex}`;
}

async function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = create();
    cache.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

async function apiRequest<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const request = page.context().request;
  const url = new URL(path, page.url()).toString();
  const response =
    method === 'GET'
      ? await request.get(url)
      : method === 'POST'
        ? await request.post(url, { data })
        : await request.patch(url, { data });

  if (!response.ok()) {
    throw new Error(`Screenshot fixture API ${method} ${path} failed (${response.status()}): ${await response.text()}`);
  }
  if (response.status() === 204) return undefined as T;
  return (await response.json()) as T;
}

async function ensureProvider(page: Page, scope: string): Promise<ProviderFixture> {
  const name = `UI Review Mock Provider ${scope}`;
  const config = {
    baseUrl: MOCK_PROVIDER_BASE_URL,
    models: [{ id: MOCK_MODEL_ID, label: 'Limits review mock', supportsTools: true }],
    stream: false,
  };
  const providers = await apiRequest<ApiProvider[]>(page, 'GET', '/api/admin/providers');
  const existing = providers.find((provider) => provider.name === name);
  let id: string;

  if (existing) {
    id = existing.id;
    await apiRequest(page, 'PATCH', `/api/admin/providers/${encodeURIComponent(id)}`, {
      name,
      config,
      enabled: true,
    });
  } else {
    const created = await apiRequest<ApiProvider>(page, 'POST', '/api/admin/providers', {
      name,
      kind: 'openai-compatible',
      config,
      enabled: true,
      isDefault: false,
    });
    id = created.id;
  }

  // The API upserts this shared credential by provider + label. Its value is
  // generated in memory and is never a real provider secret or written to disk.
  await apiRequest(page, 'POST', `/api/admin/providers/${encodeURIComponent(id)}/credentials`, {
    apiKey: randomUUID().replaceAll('-', ''),
    label: MOCK_CREDENTIAL_LABEL,
  });

  // Model discovery falls back to the deterministic model in config when this
  // deliberately unreachable local endpoint has no running mock server.
  const refreshed = await apiRequest<{ models?: Array<{ id: string }> }>(
    page,
    'POST',
    `/api/admin/providers/${encodeURIComponent(id)}/models/refresh`,
  );
  if (!refreshed.models?.some((model) => model.id === MOCK_MODEL_ID)) {
    throw new Error(`Screenshot mock provider did not expose model ${MOCK_MODEL_ID}`);
  }

  return { id, modelId: MOCK_MODEL_ID };
}

function getProvider(context: UiReviewSeedContext): Promise<ProviderFixture> {
  const scope = workerScope(context);
  return cached(providerCache, scope, () => ensureProvider(context.page, scope));
}

function providerSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  return getProvider(context).then((provider) => ({ providerId: provider.id, modelId: provider.modelId }));
}

function taskSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  const scope = workerScope(context);
  return cached(taskCache, scope, async () => {
    const provider = await getProvider(context);
    const taskTitle = `UI review limits task ${scope}`;
    const tasks = await apiRequest<ApiTask[]>(context.page, 'GET', '/api/tasks?limit=100');
    let task = tasks.find((entry) => entry.title === taskTitle);

    if (!task) {
      task = await apiRequest<ApiTask>(context.page, 'POST', '/api/tasks', {
        title: taskTitle,
        description: 'A deterministic, paused task for reviewing the execution-limits flow.',
        prompt: 'Review configured execution limits and summarize the scheduled analysis workflow.',
        systemInstructions: 'Use concise, structured analysis.',
        providerId: provider.id,
        model: provider.modelId,
        enabled: false,
        schedule: { preset: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
        allowWebResearch: true,
        notification: { email: { enabled: false, when: 'always' } },
      });
    } else if (task.providerId !== provider.id) {
      task = await apiRequest<ApiTask>(context.page, 'PATCH', `/api/tasks/${encodeURIComponent(task.id)}`, {
        providerId: provider.id,
        model: provider.modelId,
        enabled: false,
      });
    }

    return { ...provider, taskId: task.id, taskTitle };
  });
}

function executionSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  const scope = workerScope(context);
  return cached(executionCache, scope, async () => {
    const task = await taskSeed(context);
    const run = await apiRequest<{ executionId?: string }>(
      context.page,
      'POST',
      `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
    );
    const executionId = run.executionId;
    if (!executionId) throw new Error('Screenshot execution did not return an execution id');

    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const execution = await apiRequest<{ status: string }>(
        context.page,
        'GET',
        `/api/executions/${encodeURIComponent(executionId)}`,
      );
      if (execution.status === 'completed') return { ...task, executionId };
      if (['failed', 'cancelled', 'timed_out'].includes(execution.status)) {
        throw new Error(`Screenshot execution finished as ${execution.status}`);
      }
      await context.page.waitForTimeout(250);
    }
    throw new Error('Screenshot execution did not complete within 75 seconds');
  }).then(({ executionId }) => ({ executionId }));
}

async function memoryTaskSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  const execution = await executionSeed(context);
  const task = await taskSeed(context);
  const deadline = Date.now() + 20_000;
  const path = `/api/memory?scope=task&taskId=${encodeURIComponent(task.taskId)}&limit=1`;
  while (Date.now() < deadline) {
    const memories = await apiRequest<{ total: number }>(context.page, 'GET', path);
    if (memories.total > 0) return execution;
    await context.page.waitForTimeout(100);
  }
  throw new Error('Screenshot task memory did not persist within 20 seconds of execution completion');
}

async function loginAsReviewAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^Email\b/i).fill(process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@example.com');
  await page
    .getByLabel(/^Password\b/i)
    .fill(process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'local-admin-password');
  await page.getByRole('button', { name: /^(Sign in|Anmelden)$/i }).click();
  await page.getByRole('heading', { level: 1, name: /^(Dashboard|Übersicht)$/i }).waitFor();
}

async function logoutReviewAdmin(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Signed in as|Angemeldet als)$/i }).click();
  await page.getByRole('button', { name: /^(Sign out|Abmelden)$/i }).click();
  await page.getByRole('heading', { name: /^(Welcome back|Willkommen zurück)$/i }).waitFor();
}

async function invitationSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  await loginAsReviewAdmin(context.page);
  const invitation = await apiRequest<{ token: string }>(context.page, 'POST', '/api/admin/invitations', {
    email: `ui-review-${workerScope(context)}-${randomUUID()}@example.test`,
    role: 'USER',
  });
  await logoutReviewAdmin(context.page);
  return { token: invitation.token };
}

async function shareSeed(context: UiReviewSeedContext): Promise<Record<string, string>> {
  const task = await taskSeed(context);
  const share = await apiRequest<{ token: string }>(
    context.page,
    'POST',
    `/api/tasks/${encodeURIComponent(task.taskId)}/share`,
  );
  return { token: share.token };
}

export const uiReviewConfig: UiReviewConfig = {
  outputDir: 'test-results/ui-screenshots',
  expectedTitle: 'Agent Tasks',
  routes: [
    {
      name: 'login',
      path: '/login',
      states: ['empty', 'filled'],
      auth: 'guest',
      nav: [{ kind: 'goto', path: '/login', reason: 'Review the logged-out sign-in form.' }],
      prepare: {
        filled: [
          { kind: 'fill', selector: '#login-email', value: 'person@example.test' },
          { kind: 'fill', selector: '#login-password', value: 'example-password-only' },
        ],
      },
      note: 'Filled credentials are inert and are never submitted.',
    },
    {
      name: 'setup',
      path: '/setup',
      states: ['filled'],
      auth: 'guest',
      nav: [{ kind: 'goto', path: '/setup', reason: 'Review the post-bootstrap setup state.' }],
      note: 'This isolated review stack is already configured, so the route correctly shows setup is closed.',
    },
    {
      name: 'register',
      path: '/register',
      states: ['filled'],
      auth: 'guest',
      nav: [{ kind: 'goto', path: '/register', reason: 'Review the registration policy state.' }],
      note: 'Public registration is disabled in the isolated stack; the route explains that policy.',
    },
    {
      name: 'invitation',
      path: '/invite/:token',
      states: ['filled'],
      auth: 'none',
      seeds: { filled: invitationSeed },
      nav: [{ kind: 'goto', path: '/invite/:token', reason: 'Review a real, unused invitation form.' }],
      prepare: {
        filled: [
          { kind: 'fill', selector: '#invite-name', value: 'UI Review User' },
          { kind: 'fill', selector: '#invite-password', value: 'example-password-only' },
          { kind: 'fill', selector: '#invite-confirm', value: 'example-password-only' },
        ],
      },
      note: 'The invitation is synthetic, remains unaccepted, and is stored only in the isolated review database.',
    },
    {
      name: 'share-page',
      path: '/share/:token',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: shareSeed },
      nav: [{ kind: 'goto', path: '/share/:token', reason: 'Review the frozen task snapshot and adopt controls.' }],
      note: 'The share uses the screenshot fixture task and does not submit an adoption.',
    },
    {
      name: 'dashboard',
      path: '/',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/', reason: 'Review the authenticated dashboard.' }],
      note: 'A zero-task account is not created because the stack uses a shared administrator; the dashboard is captured with its fixture task.',
    },
    {
      name: 'admin-providers',
      path: '/admin/providers',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: providerSeed },
      nav: [{ kind: 'click', scope: 'complementary', role: 'link', href: '/admin/providers' }],
      note: 'Omitted empty state: the shared admin already stores the fixture provider; the capture shows the catalog, default-model and hidden-model controls.',
    },
    {
      name: 'admin-settings',
      path: '/admin',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'click', scope: 'complementary', role: 'link', href: '/admin' }],
      note: 'Omitted empty state: global settings always resolve to persisted values or configured defaults.',
    },
    {
      name: 'task-list',
      path: '/tasks',
      states: ['filled', 'empty'],
      auth: 'admin',
      seeds: { filled: taskSeed, empty: taskSeed },
      nav: [{ kind: 'click', scope: 'complementary', role: 'link', href: '/tasks' }],
      prepare: {
        filled: [{ kind: 'select', selector: '#task-status-filter', value: 'paused' }],
        empty: [{ kind: 'fill', selector: '#task-filter', value: 'ui-review-no-matching-task' }],
      },
      note: 'The filled fixture is paused, so the status filter selects it; empty is the zero-results title-filter view. A true zero-task account is omitted because this harness uses a shared admin and must not delete existing user data.',
    },
    {
      name: 'create-task',
      path: '/tasks/new',
      states: ['empty', 'filled'],
      auth: 'admin',
      seeds: { empty: providerSeed, filled: providerSeed },
      nav: [{ kind: 'goto', path: '/tasks/new', reason: 'Review the new-task form without submitting it.' }],
      prepare: {
        filled: [
          { kind: 'fill', selector: '#task-title', value: 'Weekly limits review' },
          { kind: 'fill', selector: '#task-description', value: 'A sample task for the execution-limits workflow.' },
          { kind: 'fill', selector: '#task-prompt', value: 'Summarize execution limits and the current scheduled workload.' },
          { kind: 'select', selector: '#task-provider', valueFrom: 'providerId' },
          { kind: 'select', selector: '#task-model', valueFrom: 'modelId' },
        ],
      },
      note: 'Empty is a new unsaved form; filled values are entered through the UI and never submitted.',
    },
    {
      name: 'task-detail',
      path: '/tasks/:taskId',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: taskSeed },
      nav: [{ kind: 'goto', path: '/tasks/:taskId', reason: 'Review the seeded paused task details.' }],
      note: 'Omitted empty state: task detail requires a persisted task; its id is resolved from the seeded fixture.',
    },
    {
      name: 'edit-task',
      path: '/tasks/:taskId/edit',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: taskSeed },
      nav: [{ kind: 'goto', path: '/tasks/:taskId/edit', reason: 'Review the seeded task edit form without saving it.' }],
      note: 'Omitted empty state: edit requires an existing task; its id is resolved from the seeded fixture.',
    },
    {
      name: 'memory-global-empty',
      path: '/memory',
      states: ['empty'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/memory', reason: 'Review the empty global-memory collection.' }],
      note: 'The isolated stack starts with no global memories; task-memory content is captured separately.',
    },
    {
      name: 'memory-task-filled',
      path: '/memory?scope=task',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: memoryTaskSeed },
      nav: [{ kind: 'goto', path: '/memory?scope=task', reason: 'Review fixture task memory after one deterministic fake run.' }],
      note: 'The fake runtime creates synthetic task memory; no live provider is called.',
    },
    {
      name: 'executions-empty',
      path: '/executions',
      states: ['empty'],
      auth: 'admin',
      nav: [
        { kind: 'goto', path: '/executions', reason: 'Open the execution list.' },
        { kind: 'click', scope: 'main', role: 'button', name: 'Failed' },
      ],
      note: 'The failed-status filter has no fixture failures and captures the zero-result state.',
    },
    {
      name: 'executions-filled',
      path: '/executions',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: executionSeed },
      nav: [{ kind: 'goto', path: '/executions', reason: 'Review the completed deterministic fixture execution.' }],
    },
    {
      name: 'execution-detail',
      path: '/executions/:executionId',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: executionSeed },
      nav: [{ kind: 'goto', path: '/executions/:executionId', reason: 'Review the completed execution report and timeline.' }],
    },
    {
      name: 'settings',
      path: '/settings',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/settings', reason: 'Review account settings and preferences.' }],
    },
    {
      name: 'admin-users',
      path: '/admin/users',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/admin/users', reason: 'Review administrator user and invitation management.' }],
    },
    {
      name: 'admin-audit',
      path: '/admin/audit',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/admin/audit', reason: 'Review the populated audit log.' }],
    },
    {
      name: 'admin-monitoring',
      path: '/admin/monitoring',
      states: ['filled'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/admin/monitoring', reason: 'Review runtime and queue monitoring.' }],
    },
    {
      name: 'share-invalid',
      path: '/share/ui-review-invalid-token',
      states: ['empty'],
      auth: 'guest',
      nav: [{ kind: 'goto', path: '/share/ui-review-invalid-token', reason: 'Review the safe not-found state for a dead share token.' }],
    },
    {
      name: 'not-found',
      path: '/ui-review-not-found',
      states: ['empty'],
      auth: 'admin',
      nav: [{ kind: 'goto', path: '/ui-review-not-found', reason: 'Review the authenticated not-found page.' }],
    },
  ],
};

export const routes = uiReviewConfig.routes;
