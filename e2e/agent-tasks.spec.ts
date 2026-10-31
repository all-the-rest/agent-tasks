import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { createMockOpenAiServer } from '@agent-tasks/mock-openai';
import type { MockServer } from '@agent-tasks/mock-openai';

/**
 * Browser E2E against the real compose stack.
 *
 * The model endpoint is the deterministic OpenAI-compatible server from
 * `packages/mock-openai`: a real HTTP server that enforces the client contract
 * (honest User-Agent, stable `x-opencode-session`) and answers without a model
 * download. Ollama is deliberately not used.
 *
 * Ordering matters only for the expensive shared fixtures (one administrator,
 * one mock inference provider). Every test creates its own browser context and
 * its own data; no test relies on cookies left behind by another test.
 */
test.describe.configure({ mode: 'serial' });

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

/** Fails the test instead of skipping it when a serial fixture is missing. */
function requireFixture<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} is not available; the prerequisite test failed`);
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
  token: string;
  link: string;
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

let mock: MockServer | undefined;
let adminState: StorageState | undefined;
let userOneState: StorageState | undefined;
let adminEmail = '';
let adminPassword = '';
let userOneEmail = '';
let userOnePassword = '';
let taskId = '';
let taskTitle = '';
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
  if (!adminState) throw new Error('admin storage state is not available');
  const context = await browser.newContext({ storageState: adminState });
  return { context, page: await context.newPage() };
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
  const page = await context.newPage();
  await page.goto(invitePath(link));
  await expect(page.getByText(`Invitation for ${email}`)).toBeVisible();
  await page.getByLabel(/^Name\b/).fill(name);
  await page.getByLabel(/^Password\b/).fill(password);
  await page.getByLabel(/^Confirm password\b/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const state = await context.storageState();
  await context.close();
  return state;
}

/**
 * Creates (or repairs) the deterministic OpenAI-compatible provider through the
 * admin API. The mock exposes `/v1/models`, so the model list is discovered the
 * same way a real endpoint's would be; a shared API key satisfies the adapter's
 * credential requirement (the mock ignores its value but the API does not).
 */
async function ensureMockProvider(request: APIRequestContext): Promise<void> {
  const server = requireFixture(mock, 'the mock OpenAI server');
  const list = await request.get('/api/admin/providers');
  expect(list.ok(), `provider list failed: ${list.status()} ${await list.text()}`).toBeTruthy();
  const providers = (await list.json()) as AdminProvider[];
  const existing = providers.find((provider) => provider.name === MOCK_PROVIDER_NAME);
  const config = {
    baseUrl: server.url,
    models: [{ id: MOCK_MODEL, supportsTools: true }],
  };

  let providerId = existing?.id;
  if (providerId) {
    const patched = await request.patch(`/api/admin/providers/${providerId}`, {
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
    providerId = ((await created.json()) as AdminProvider).id;
  }

  const credential = await request.post(`/api/admin/providers/${providerId}/credentials`, {
    data: { apiKey: MOCK_API_KEY, label: 'e2e' },
  });
  expect(credential.ok(), `credential creation failed: ${credential.status()} ${await credential.text()}`).toBeTruthy();

  const refreshed = await request.post(`/api/admin/providers/${providerId}/models/refresh`);
  expect(refreshed.ok(), `model refresh failed: ${refreshed.status()} ${await refreshed.text()}`).toBeTruthy();
  const payload = (await refreshed.json()) as { models?: Array<{ id: string }> };
  expect(
    payload.models?.some((model) => model.id === MOCK_MODEL),
    `the stack cannot reach the mock at ${server.url}; discovered ${JSON.stringify(payload.models ?? [])}`,
  ).toBe(true);
}

test.beforeAll(async () => {
  const target = mockOrigin();
  // No research steps: the deterministic answer is the first (and only) model call.
  mock = await createMockOpenAiServer({ researchSteps: 2, port: target.port, publicOrigin: target.origin });
});

test.afterAll(async () => {
  await mock?.close();
});

test('first-admin setup (or guarded login on an already configured instance)', async ({ browser, request }) => {
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

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, email!, password!);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    adminEmail = email!;
    adminPassword = password!;
    adminState = await context.storageState();
    await context.close();
    return;
  }

  const setupToken = process.env.E2E_SETUP_TOKEN;
  expect(setupToken, 'E2E_SETUP_TOKEN is required to create the first administrator').toBeTruthy();

  adminEmail = uniqueEmail('admin');
  adminPassword = uniquePassword();

  const context = await browser.newContext();
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
  await context.close();
});

test('login rejects a wrong password, then signs in and out', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');

  const context = await browser.newContext();
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
  await context.close();
});

test('admin invites a user through the UI and the invitation is accepted', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');

  const { context: adminContext, page } = await openAdminContext(browser);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

  userOneEmail = uniqueEmail('user1');
  userOnePassword = uniquePassword();
  await page.getByLabel('Email address').fill(userOneEmail);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation created.').first()).toBeVisible();

  const link = (await page.getByText(/\/invite\/[A-Za-z0-9_-]+/).first().textContent())?.trim();
  expect(link, 'the invitation link must be shown in the UI').toBeTruthy();
  await adminContext.close();

  userOneState = await acceptInvitation(browser, link!, 'E2E User One', userOneEmail, userOnePassword);
});

test('creates a task and shows its schedule and next run', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');

  const { context, page } = await openAdminContext(browser);
  await ensureMockProvider(context.request);

  taskTitle = `E2E briefing ${Date.now()}`;
  await page.goto('/tasks/new');
  // TaskFormPage resets its react-hook-form values when `/api/me` and the provider
  // list resolve; typing before that wipes the input. Wait until the provider/model
  // auto-selection has happened, then fill.
  await expect(page.getByLabel('Provider')).not.toHaveValue('');
  await expect(page.getByLabel('Model')).toHaveValue(MOCK_MODEL);
  await page.getByLabel('Title').fill(taskTitle);
  await page.getByLabel('Prompt').fill('Research the deterministic E2E topic and summarise the findings for the report.');
  await page.getByLabel('Allow web research').check();

  await page.getByRole('button', { name: 'Save task' }).click();

  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  taskId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

  await expect(page.getByRole('heading', { level: 1, name: taskTitle })).toBeVisible();
  await expect(page.getByText(/Every day at/)).toBeVisible();
  const nextRun = page.locator('dt', { hasText: 'Next run' }).locator('xpath=following-sibling::dd[1]');
  await expect(nextRun).toBeVisible();
  await expect(nextRun).not.toHaveText('Never');

  await page.goto('/tasks');
  await expect(page.getByRole('row').filter({ hasText: taskTitle })).toBeVisible();
  await context.close();
});

test('pauses and resumes the task and the list reflects both states', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');
  requireFixture(taskId, 'task fixture');

  const { context, page } = await openAdminContext(browser);
  await page.goto('/tasks');
  const row = page.getByRole('row').filter({ hasText: taskTitle });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();

  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row.getByText('Enabled', { exact: true })).toBeVisible();

  // The state must survive a reload: it is server state, not only a cache.
  await page.reload();
  const reloaded = page.getByRole('row').filter({ hasText: taskTitle });
  await expect(reloaded.getByText('Enabled', { exact: true })).toBeVisible();
  await context.close();
});

test('runs the task now and opens the execution without a JS error', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');
  const currentTaskId = requireFixture(taskId, 'task fixture');
  const server = requireFixture(mock, 'mock OpenAI server');
  const requestsBeforeRun = server.requests.length;

  const { context, page } = await openAdminContext(browser);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`/tasks/${currentTaskId}`);
  const runResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith(`/api/tasks/${currentTaskId}/run`),
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
  // The deterministic mock answers on the first model call, so the worker
  // reaches `completed` without a model download.
  await expect(statusBadge).toHaveText('Completed', { timeout: 75_000 });

  const chatRequests = server.requests
    .slice(requestsBeforeRun)
    .filter((request) => request.path.endsWith('/chat/completions'));
  expect(chatRequests.length, 'the worker must call the mock model endpoint at least once').toBeGreaterThan(0);
  expect(chatRequests.every((request) => request.body?.model === MOCK_MODEL)).toBe(true);

  await page.reload();
  await expect(page.getByText('Status', { exact: true })).toBeVisible();
  await expect(page.locator('.badge').filter({ hasText: /^Completed$/ }).first()).toBeVisible();
  expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
  await context.close();
});

test("a second user cannot open another user's task", async ({ browser }) => {
  requireFixture(adminState, 'administrator session');
  const currentTaskId = requireFixture(taskId, 'task fixture');

  const { context: adminContext } = await openAdminContext(browser);
  const secondEmail = uniqueEmail('user2');
  const secondPassword = uniquePassword();
  const invitationResponse = await adminContext.request.post('/api/admin/invitations', {
    data: { email: secondEmail, role: 'USER' },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as InvitationResponse;
  await adminContext.close();

  const secondState = await acceptInvitation(
    browser,
    invitation.link,
    'E2E User Two',
    secondEmail,
    secondPassword,
  );

  const secondContext = await browser.newContext({ storageState: secondState });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(`/tasks/${currentTaskId}`);
  await expect(secondPage.getByRole('alert')).toContainText('The requested resource was not found.');
  await expect(secondPage.getByText(taskTitle)).toHaveCount(0);
  await secondContext.close();
});

test('admin pages are visible to admins and redirect user-role sessions', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');
  requireFixture(userOneState, 'invited user session');

  const { context: adminContext, page: adminPage } = await openAdminContext(browser);
  await adminPage.goto('/admin/users');
  await expect(adminPage.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(adminPage.getByRole('row').filter({ hasText: adminEmail })).toBeVisible();
  await adminContext.close();

  const userContext = await browser.newContext({ storageState: userOneState });
  const userPage = await userContext.newPage();
  await userPage.goto('/admin');
  await expect(userPage).toHaveURL(/\/$/);
  await expect(userPage.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(userPage.getByText('Administration', { exact: true })).toHaveCount(0);
  await userContext.close();
});

test('switches the interface language to German and back', async ({ browser }) => {
  requireFixture(adminState, 'administrator session');

  const { context, page } = await openAdminContext(browser);
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
  await context.close();
});
