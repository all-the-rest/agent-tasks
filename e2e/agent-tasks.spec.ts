import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createMockOpenAiServer } from '@agent-tasks/mock-openai';
import type { MockServer } from '@agent-tasks/mock-openai';

/**
 * Browser E2E against the real compose stack.
 *
 * The worker executes through the test-only fake runtime provisioner, so no model
 * download or provider egress is needed. The deterministic OpenAI-compatible
 * server from `packages/mock-openai` still backs the admin provider: discovery and
 * health checks run through the real API, while task execution returns the fake
 * runtime's deterministic answer. With `FAKE_RUNTIME_MEMORY_OPS=1` the fake also
 * emits one finding and one recommendation per session, so the learning UI stays
 * covered end to end.
 *
 * Shared infrastructure (administrator bootstrap, the mock provider and the mock
 * server itself) is created once in `beforeAll`. Every test then receives its own
 * browser context and creates its own tasks and memories. Created tasks and
 * global memories are registered with the `cleanup` fixture, which removes them
 * even when an assertion fails. No test reads state produced by another test.
 */

const MOCK_PROVIDER_NAME = 'E2E Mock OpenAI';
const MOCK_MODEL = 'mock-researcher';
const MOCK_API_KEY = 'e2e-mock-api-key';
const MOCK_PORT = 18_099;

/**
 * Origin the compose containers use for the mock. CI sets `E2E_MOCK_BASE_URL` to
 * the Docker bridge gateway; otherwise bind the port on every interface and
 * advertise this host's first non-loopback IPv4, which a local bridge can reach.
 */
function mockOrigin(): { port: number; origin: string } {
  const configured = process.env.E2E_MOCK_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (!url.port) throw new Error('E2E_MOCK_BASE_URL must include an explicit port');
    return { port: Number(url.port), origin: configured.replace(/\/+$/, '') };
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return { port: MOCK_PORT, origin: `http://${entry.address}:${MOCK_PORT}` };
      }
    }
  }
  return { port: MOCK_PORT, origin: `http://127.0.0.1:${MOCK_PORT}` };
}

/** Fails the test instead of silently continuing when shared setup is missing. */
function requireFixture<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} is not available; the E2E setup did not complete`);
  }
  return value;
}

interface AdminProvider {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
}

interface RunResponse {
  executionId?: string;
}

interface InvitationResponse {
  id: string;
  token: string;
  link: string;
}

interface CreatedTask {
  id: string;
  title: string;
  /** Unique text carried by every model request of this test. */
  marker: string;
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

let mock: MockServer | undefined;
let adminState: StorageState | undefined;
let adminEmail = '';
let adminPassword = '';
let providerId = '';
let emailCounter = 0;

function uniqueEmail(tag: string): string {
  emailCounter += 1;
  return `e2e+${Date.now()}-${emailCounter}-${tag}@example.com`;
}

function uniquePassword(): string {
  return `E2e!${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  // The shared `Field` component renders the required marker inside the <label>
  // ("Email*"), so `exact: true` on the label text never matches; anchor instead.
  await page.getByLabel(/^Email\b/).fill(email);
  await page.getByLabel(/^Password\b/).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function openAdminContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: requireFixture(adminState, 'administrator session') });
  return { context, page: await context.newPage() };
}

async function runTaskNow(page: Page, currentTaskId: string): Promise<string> {
  await page.goto(`/tasks/${currentTaskId}`);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith(`/api/tasks/${currentTaskId}/run`),
  );
  await page.getByRole('button', { name: 'Run now' }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as RunResponse;
  const executionId = requireFixture(body.executionId, 'execution id');
  await page.goto(`/executions/${executionId}`);
  await expect(page.locator('.badge').filter({ hasText: /^Completed$/ }).first()).toHaveText('Completed', { timeout: 75_000 });
  return executionId;
}

/** Accepts absolute links as well as the path-only form some deployments emit. */
function invitePath(link: string): string {
  const url = new URL(link, 'http://e2e.invalid');
  return `${url.pathname}${url.search}`;
}

async function acceptInvitation(
  browser: Browser,
  link: string,
  name: string,
  email: string,
  password: string,
): Promise<StorageState> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(invitePath(link));
    await expect(page.getByText(`Invitation for ${email}`)).toBeVisible();
    await page.getByLabel(/^Name\b/).fill(name);
    await page.getByLabel(/^Password\b/).fill(password);
    await page.getByLabel(/^Confirm password\b/).fill(password);
    const acceptResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/invitations/accept',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Create account' }).click();
    const acceptResponse = await acceptResponsePromise;
    expect(acceptResponse.ok(), `invitation acceptance returned HTTP ${acceptResponse.status()}`).toBeTruthy();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/**
 * Creates (or repairs) the deterministic OpenAI-compatible provider through the
 * admin API. The mock exposes `/v1/models`, so the model list is discovered the
 * same way a real endpoint's would be; a shared API key satisfies the adapter's
 * credential requirement (the mock ignores its value but the API does not).
 */
async function ensureMockProvider(request: APIRequestContext): Promise<string> {
  const server = requireFixture(mock, 'the mock OpenAI server');
  const list = await request.get('/api/admin/providers');
  expect(list.ok(), `provider list failed: ${list.status()} ${await list.text()}`).toBeTruthy();
  const providers = (await list.json()) as AdminProvider[];
  const existing = providers.find((provider) => provider.name === MOCK_PROVIDER_NAME);
  const config = {
    baseUrl: server.url,
    models: [{ id: MOCK_MODEL, supportsTools: true }],
  };

  let id = existing?.id;
  if (id) {
    const patched = await request.patch(`/api/admin/providers/${id}`, {
      data: { config, enabled: true, isDefault: true },
    });
    expect(patched.ok(), `provider update failed: ${patched.status()} ${await patched.text()}`).toBeTruthy();
  } else {
    const created = await request.post('/api/admin/providers', {
      data: {
        name: MOCK_PROVIDER_NAME,
        kind: 'openai-compatible',
        config,
        enabled: true,
        isDefault: true,
      },
    });
    expect(created.ok(), `provider creation failed: ${created.status()} ${await created.text()}`).toBeTruthy();
    id = ((await created.json()) as AdminProvider).id;
  }

  const credential = await request.post(`/api/admin/providers/${id}/credentials`, {
    data: { apiKey: MOCK_API_KEY, label: 'e2e' },
  });
  expect(credential.ok(), `credential creation failed: ${credential.status()} ${await credential.text()}`).toBeTruthy();

  const refreshed = await request.post(`/api/admin/providers/${id}/models/refresh`);
  expect(refreshed.ok(), `model refresh failed: ${refreshed.status()} ${await refreshed.text()}`).toBeTruthy();
  const payload = (await refreshed.json()) as { models?: Array<{ id: string }> };
  expect(
    payload.models?.some((model) => model.id === MOCK_MODEL),
    `the stack cannot reach the mock at ${server.url}; discovered ${JSON.stringify(payload.models ?? [])}`,
  ).toBe(true);
  return id;
}

/**
 * Creates a task through the authenticated API. The unique marker keeps each
 * test's prompt distinct on the shared E2E database.
 */
async function createTask(
  request: APIRequestContext,
  options: { title?: string; enabled?: boolean } = {},
): Promise<CreatedTask> {
  const title = options.title ?? `E2E task ${Date.now()} ${randomUUID().slice(0, 8)}`;
  const marker = `E2E marker ${randomUUID()}`;
  const response = await request.post('/api/tasks', {
    data: {
      title,
      prompt: `Research the deterministic E2E topic and summarise the findings for the report. ${marker}`,
      providerId: requireFixture(providerId, 'mock provider'),
      model: MOCK_MODEL,
      enabled: options.enabled ?? true,
      schedule: { preset: 'daily', timezone: 'Europe/Vienna', hour: 6, minute: 30 },
      allowWebResearch: false,
      notification: 'none',
      memorySettings: { mode: 'auto', contextBytes: 12_000 },
    },
  });
  expect(response.ok(), `task creation failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  const task = (await response.json()) as { id: string };
  expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  return { id: task.id, title, marker };
}

interface Cleanup {
  /** Deletes a task (and its cascaded memory/recommendations) after the test. */
  task: (id: string) => void;
  /** Deletes one global memory after the test. */
  memory: (id: string) => void;
  /** Finds global memories by a unique phrase and deletes them after the test. */
  memorySearch: (query: string) => void;
}

const test = base.extend<{
  admin: { context: BrowserContext; page: Page };
  cleanup: Cleanup;
}>({
  admin: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: requireFixture(adminState, 'administrator session') });
    const page = await context.newPage();
    await use({ context, page });
    await context.close();
  },

  cleanup: async ({ admin }, use) => {
    const tasks = new Set<string>();
    const memories = new Set<string>();
    const searches: string[] = [];
    await use({
      task: (id) => {
        if (id) tasks.add(id);
      },
      memory: (id) => {
        if (id) memories.add(id);
      },
      memorySearch: (query) => {
        if (query) searches.push(query);
      },
    });

    for (const query of searches) {
      const response = await admin.context.request.get('/api/memory', {
        params: { scope: 'global', q: query, limit: 100 },
      });
      if (!response.ok()) continue;
      const payload = (await response.json()) as { items?: Array<{ id: string }> };
      for (const item of payload.items ?? []) memories.add(item.id);
    }

    for (const id of memories) {
      const response = await admin.context.request.delete(`/api/memory/${id}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`memory cleanup failed for ${id}: ${response.status()} ${await response.text()}`);
      }
    }

    for (const id of tasks) {
      const response = await admin.context.request.delete(`/api/tasks/${id}`);
      if (!response.ok() && response.status() !== 404) {
        throw new Error(`task cleanup failed for ${id}: ${response.status()} ${await response.text()}`);
      }
    }
  },
});

test.beforeAll(async ({ browser, request }) => {
  const target = mockOrigin();
  // Discovery and provider health only; task execution uses the fake provisioner.
  mock = await createMockOpenAiServer({
    port: target.port,
    publicOrigin: target.origin,
  });

  const statusResponse = await request.get('/api/setup/status');
  expect(statusResponse.ok()).toBeTruthy();
  const status = (await statusResponse.json()) as { configured: boolean };

  if (status.configured) {
    const email = process.env.E2E_ADMIN_EMAIL;
    const password = process.env.E2E_ADMIN_PASSWORD;
    expect(
      email && password,
      'this instance is already configured; set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run the suite',
    ).toBeTruthy();
    adminEmail = email!;
    adminPassword = password!;

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page, adminEmail, adminPassword);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      adminState = await context.storageState();
    } finally {
      await context.close();
    }
  } else {
    const setupToken = process.env.E2E_SETUP_TOKEN;
    expect(setupToken, 'E2E_SETUP_TOKEN is required to create the first administrator').toBeTruthy();
    const configuredEmail = process.env.E2E_ADMIN_EMAIL?.trim();
    const configuredPassword = process.env.E2E_ADMIN_PASSWORD;
    expect(
      Boolean(configuredEmail) === Boolean(configuredPassword),
      'set both E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD, or neither',
    ).toBeTruthy();
    adminEmail = configuredEmail || uniqueEmail('admin');
    adminPassword = configuredPassword || uniquePassword();

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto('/setup');
      await page.getByLabel('Setup token').fill(setupToken!);
      await page.getByLabel(/^Name\b/).fill('E2E Admin');
      await page.getByLabel(/^Email\b/).fill(adminEmail);
      await page.getByLabel(/^Password\b/).fill(adminPassword);
      await page.getByLabel(/^Confirm password\b/).fill(adminPassword);
      await page.getByRole('button', { name: 'Create administrator' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      adminState = await context.storageState();
    } finally {
      await context.close();
    }
  }

  // Shared setup only; no test depends on another test having run. The locale is
  // reset so a previous interrupted language test cannot affect this suite.
  const setupContext = await browser.newContext({ storageState: adminState });
  try {
    const reset = await setupContext.request.patch('/api/me/preferences', { data: { locale: 'en' } });
    expect(reset.ok(), `locale reset failed: ${reset.status()} ${await reset.text()}`).toBeTruthy();
    providerId = await ensureMockProvider(setupContext.request);
  } finally {
    await setupContext.close();
  }
});

test.afterAll(async () => {
  await mock?.close();
});

test('login rejects a wrong password, then signs in and out', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();

    await signIn(page, adminEmail, 'definitely-not-the-right-password');
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/incorrect|invalid|falsch|wrong/i);
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel(/^Password\b/).fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    await page.getByRole('button', { name: 'Signed in as' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await context.close();
  }
});

test('admin invites a user through the UI and the invitation is accepted', async ({ browser, admin }) => {
  const { page } = admin;
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

  const userEmail = uniqueEmail('user1');
  const userPassword = uniquePassword();
  await page.getByLabel('Email address').fill(userEmail);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation created.').first()).toBeVisible();

  const link = (await page.getByText(/\/invite\/[A-Za-z0-9_-]+/).first().textContent())?.trim();
  expect(link, 'the invitation link must be shown in the UI').toBeTruthy();

  // Accepted E2E users cannot be deleted through the product API; the unique
  // address keeps this test isolated on a shared E2E database.
  await acceptInvitation(browser, link!, 'E2E User One', userEmail, userPassword);
});

test('creates a task and shows its schedule and next run', async ({ admin, cleanup }) => {
  const { page } = admin;

  const title = `E2E briefing ${Date.now()}`;
  const marker = `E2E marker ${randomUUID()}`;
  await page.goto('/tasks/new');
  // TaskFormPage resets its react-hook-form values when `/api/me` and the provider
  // list resolve; typing before that wipes the input. Wait until the provider/model
  // auto-selection has happened, then fill.
  await expect(page.getByLabel('Provider')).not.toHaveValue('');
  await expect(page.getByLabel('Model')).toHaveValue(MOCK_MODEL);
  await page.getByLabel('Title').fill(title);
  await page
    .getByLabel('Prompt')
    .fill(`Research the deterministic E2E topic and summarise the findings for the report. ${marker}`);
  await page.getByLabel('Allow web research').check();

  await page.getByRole('button', { name: 'Save task' }).click();

  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  cleanup.task(taskId);

  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(/Every day at/)).toBeVisible();
  const nextRun = page.locator('dt', { hasText: 'Next run' }).locator('xpath=following-sibling::dd[1]');
  await expect(nextRun).toBeVisible();
  await expect(nextRun).not.toHaveText('Never');

  await page.goto('/tasks');
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
});

test('pauses and resumes the task and the list reflects both states', async ({ admin, cleanup }) => {
  const { page } = admin;
  const task = await createTask(admin.context.request, { title: `E2E pause ${Date.now()}` });
  cleanup.task(task.id);

  await page.goto('/tasks');
  const row = page.getByRole('row').filter({ hasText: task.title });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row).not.toBeVisible();
  await page.locator('#task-status-filter').selectOption('paused');
  await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();

  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row).not.toBeVisible();
  await page.locator('#task-status-filter').selectOption('active');
  await expect(row.getByText('Active', { exact: true })).toBeVisible();

  // The state must survive a reload: it is server state, not only a cache.
  await page.reload();
  const reloaded = page.getByRole('row').filter({ hasText: task.title });
  await expect(reloaded.getByText('Active', { exact: true })).toBeVisible();
});

test('runs the task now and opens the execution without a JS error', async ({ admin, cleanup }) => {
  const { context, page } = admin;
  const task = await createTask(context.request, { title: `E2E run ${Date.now()}` });
  cleanup.task(task.id);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`/tasks/${task.id}`);
  const runResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith(`/api/tasks/${task.id}/run`),
  );
  await page.getByRole('button', { name: 'Run now' }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.ok()).toBeTruthy();
  const run = (await runResponse.json()) as RunResponse;
  const executionId = requireFixture(run.executionId, 'execution id');

  await page.goto(`/executions/${executionId}`);
  const statusBadge = page.locator('.badge').filter({ hasText: /^(Queued|Running|Completed)$/ }).first();
  await expect(statusBadge).toBeVisible();
  await expect(statusBadge).toHaveText(/^(Queued|Running|Completed)$/);
  // The fake provisioned runtime answers immediately, so the worker reaches
  // `completed` without a model download or provider egress.
  await expect(statusBadge).toHaveText('Completed', { timeout: 75_000 });
  await expect(
    page.getByText('A deterministic fake OpenCode report', { exact: false }).first(),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByText('Status', { exact: true })).toBeVisible();
  await expect(page.locator('.badge').filter({ hasText: /^Completed$/ }).first()).toBeVisible();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
});

test('saves a global preference with /learn and keeps it across browser contexts', async ({ browser, admin, cleanup }) => {
  const { page } = admin;
  const main = page.locator('#main-content');
  const preference = `Prefer concise executive summaries ${randomUUID()}.`;
  cleanup.memorySearch(preference);

  await page.goto('/memory');
  const commandInput = page.getByLabel('Slash command').filter({ visible: true });
  await commandInput.fill(`/learn ${preference}`);
  await commandInput.locator('..').getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Memory saved.').first()).toBeVisible();
  await expect(main.getByText(preference, { exact: true })).toBeVisible();

  // A second, fresh browser context: the command result was persisted server-side,
  // not only in the first tab's component state.
  const second = await openAdminContext(browser);
  try {
    const secondMain = second.page.locator('#main-content');
    await second.page.goto('/memory');
    await expect(secondMain.getByText(preference, { exact: true })).toBeVisible();

    const card = secondMain.locator('li').filter({ hasText: preference }).first();
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    await second.page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(second.page.getByText('Memory deleted.').first()).toBeVisible();
    await expect(secondMain.getByText(preference, { exact: true })).toHaveCount(0);
  } finally {
    await second.context.close();
  }
});

test('reuses task memory and tracked recommendations on the next execution', async ({ admin, cleanup }) => {
  const { page } = admin;
  const task = await createTask(admin.context.request, { title: `E2E memory ${Date.now()}` });
  cleanup.task(task.id);

  // First execution creates the task memory and recommendation through the
  // worker's MCP bridge.
  await runTaskNow(page, task.id);

  await page.goto(`/tasks/${task.id}`);
  const main = page.locator('#main-content');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(main.getByText('E2E finding: the alpha launch price is 42 units at the observed source.', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Recommendations' }).click();
  await expect(main.getByRole('heading', { name: 'Alpha offer', exact: true })).toHaveCount(1);

  // The fake runtime echoes what the worker injected into its system prompt, so
  // the report proves the second run received both memory and recommendations.
  await runTaskNow(page, task.id);
  await expect(main.getByText(/Previous task memory was provided to this run/).first()).toBeVisible();
  await expect(main.getByText(/Existing tracked recommendations were recognized/).first()).toBeVisible();

  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('tab', { name: 'Recommendations' }).click();
  await expect(main.getByRole('heading', { name: 'Alpha offer', exact: true })).toHaveCount(1);
});

test('edits and deletes a memory so later executions respect the change', async ({ admin, cleanup }) => {
  const { page } = admin;
  const task = await createTask(admin.context.request, { title: `E2E correction ${Date.now()}` });
  cleanup.task(task.id);
  const corrected = 'E2E corrected finding: the alpha launch price is 39 units, verified by the user.';

  // Populate the task memory with one execution.
  await runTaskNow(page, task.id);

  await page.goto(`/tasks/${task.id}`);
  const main = page.locator('#main-content');
  await page.getByRole('tab', { name: 'Memory' }).click();
  const card = main.locator('li').filter({ hasText: 'E2E finding: the alpha launch price' }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Content').fill(corrected);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Memory updated.').first()).toBeVisible();
  await expect(main.getByText(corrected, { exact: true }).first()).toBeVisible();

  const editedRunId = await runTaskNow(page, task.id);
  // The run still sees *some* memory context (hence the marker) but the report
  // never contains the user-corrected text; the prompt is not stored.
  await expect(page.getByText(/Previous task memory was provided to this run/).first()).toBeVisible();
  const editedReport = await page.locator('#main-content').textContent();
  expect(editedReport).not.toContain('E2E finding: the alpha launch price is 42');

  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('tab', { name: 'Memory' }).click();
  const correctedCard = main.locator('li').filter({ hasText: corrected }).first();
  await correctedCard.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText('Memory deleted.').first()).toBeVisible();
  await expect(main.getByText(corrected, { exact: true })).toHaveCount(0);

  await runTaskNow(page, task.id);
  // The tombstone blocks the deleted finding, so the fake runtime no longer sees a
  // TASK MEMORY block; the still-accepted recommendation is injected as before.
  await expect(page.getByText(/Existing tracked recommendations were recognized/).first()).toBeVisible();
  const currentReportHeading = page.getByRole('heading', { name: 'Current report', exact: true });
  const deletedReport = await currentReportHeading.locator('..').textContent();
  expect(deletedReport).not.toContain('Previous task memory was provided to this run');
  expect(deletedReport).toContain('Existing tracked recommendations were recognized');
  expect(editedRunId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a second user cannot open another user's task", async ({ browser, admin, cleanup }) => {
  const task = await createTask(admin.context.request, { title: `E2E private ${Date.now()}` });
  cleanup.task(task.id);

  const secondEmail = uniqueEmail('user2');
  const secondPassword = uniquePassword();
  const invitationResponse = await admin.context.request.post('/api/admin/invitations', {
    data: { email: secondEmail, role: 'USER' },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as InvitationResponse;

  // Accepted E2E users cannot be deleted through the product API; the unique
  // address keeps this test isolated on a shared E2E database.
  const secondState = await acceptInvitation(browser, invitation.link, 'E2E User Two', secondEmail, secondPassword);
  const secondContext = await browser.newContext({ storageState: secondState });
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`/tasks/${task.id}`);
    await expect(secondPage.getByRole('alert')).toContainText('The requested resource was not found.');
    await expect(secondPage.getByText(task.title)).toHaveCount(0);
  } finally {
    await secondContext.close();
  }
});

test('admin pages are visible to admins and redirect user-role sessions', async ({ browser, admin }) => {
  await admin.page.goto('/admin/users');
  await expect(admin.page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(admin.page.getByRole('row').filter({ hasText: adminEmail })).toBeVisible();

  const userEmail = uniqueEmail('user-admin');
  const userPassword = uniquePassword();
  const invitationResponse = await admin.context.request.post('/api/admin/invitations', {
    data: { email: userEmail, role: 'USER' },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as InvitationResponse;

  // Accepted E2E users cannot be deleted through the product API; the unique
  // address keeps this test isolated on a shared E2E database.
  const userState = await acceptInvitation(browser, invitation.link, 'E2E User Admin', userEmail, userPassword);
  const userContext = await browser.newContext({ storageState: userState });
  try {
    const userPage = await userContext.newPage();
    await userPage.goto('/admin');
    await expect(userPage).toHaveURL(/\/$/);
    await expect(userPage.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(userPage.getByText('Administration', { exact: true })).toHaveCount(0);
  } finally {
    await userContext.close();
  }
});

test('switches the interface language to German and back', async ({ admin }) => {
  const { page } = admin;
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

  // The header language toggle carries aria-label="Language" too; scope to the page
  // content so the preference <select> is the only match.
  const main = page.locator('#main-content');
  await main.getByLabel('Language').selectOption('de');
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aufgaben' })).toBeVisible();

  await main.getByLabel('Sprache').selectOption('en');
  await expect(page.getByRole('link', { name: 'Tasks' })).toBeVisible();

  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.').first()).toBeVisible();
});
