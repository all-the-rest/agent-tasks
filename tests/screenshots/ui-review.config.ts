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

const MOCK_MODEL_ID = 'ui-review-mock-model';
const MOCK_PROVIDER_BASE_URL = 'http://127.0.0.1:1/v1';
const MOCK_CREDENTIAL_LABEL = 'ui-review-screenshots';
const providerCache = new Map<string, Promise<ProviderFixture>>();
const taskCache = new Map<string, Promise<TaskFixture>>();

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
        notification: 'none',
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

export const uiReviewConfig: UiReviewConfig = {
  outputDir: 'test-results/ui-screenshots',
  expectedTitle: 'Agent Tasks',
  routes: [
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
        empty: [{ kind: 'fill', selector: '#task-filter', value: 'ui-review-no-matching-task' }],
      },
      note: 'The empty capture is the zero-results filter view. A true zero-task account is omitted because this harness uses a shared admin and must not delete existing user data.',
    },
    {
      name: 'create-task',
      path: '/tasks/new',
      states: ['empty', 'filled'],
      auth: 'admin',
      seeds: { empty: providerSeed, filled: providerSeed },
      nav: [
        { kind: 'click', scope: 'complementary', role: 'link', href: '/tasks' },
        { kind: 'click', scope: 'main', role: 'link', href: '/tasks/new' },
      ],
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
      nav: [
        { kind: 'click', scope: 'complementary', role: 'link', href: '/tasks' },
        { kind: 'click', scope: 'main', role: 'link', nameFrom: 'taskTitle' },
      ],
      note: 'Omitted empty state: task detail requires a persisted task; the fixture is resolved by its deterministic title.',
    },
    {
      name: 'edit-task',
      path: '/tasks/:taskId/edit',
      states: ['filled'],
      auth: 'admin',
      seeds: { filled: taskSeed },
      nav: [
        { kind: 'click', scope: 'complementary', role: 'link', href: '/tasks' },
        { kind: 'click', scope: 'main', role: 'link', nameFrom: 'taskTitle' },
        { kind: 'click', scope: 'main', role: 'link', href: '/tasks/:taskId/edit' },
      ],
      note: 'Omitted empty state: edit requires an existing task and follows the task detail Edit link.',
    },
  ],
};

export const routes = uiReviewConfig.routes;
