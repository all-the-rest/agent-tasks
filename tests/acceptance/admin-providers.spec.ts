import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * Acceptance evidence for #30: the admin provider page in its empty, filled,
 * error and rotated states, in English and German.
 *
 * Run against a disposable stack:
 *   E2E_BASE_URL=http://localhost:8080 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
 *     pnpm test:screenshots:acceptance
 *
 * It removes existing
 * providers to reach the empty state, then builds one OpenAI-compatible provider
 * whose catalog is declared in `config.models` — `models/refresh` discovers no
 * endpoint and falls back to the declared models, exactly like a real connection
 * whose `/models` route is unavailable. No network access and no real key are
 * needed; the key is a random string that never leaves the encrypted column.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'local-admin-password';
const OUT = path.resolve(process.cwd(), 'docs/verification/admin-providers');

const LANGUAGES = [
  { code: 'en', locale: 'en-US', empty: 'No providers configured yet.', health: /Health check/ },
  { code: 'de', locale: 'de-DE', empty: 'Noch keine Anbieter konfiguriert.', health: /Zustandsprüfung/ },
] as const;

const PROVIDER_NAME = 'OpenCode Go';
const MODELS = [
  { id: 'opencode-go/kimi-k2.5', label: 'Kimi K2.5', supportsTools: true, contextLength: 262_144 },
  { id: 'opencode-go/qwen3-coder', label: 'Qwen3 Coder', supportsTools: true, contextLength: 131_072 },
  { id: 'opencode-go/glm-5', label: 'GLM-5', supportsTools: false, contextLength: 65_536 },
];

interface AdminProviderRow {
  id: string;
  name: string;
}

async function signIn(page: Page, language: (typeof LANGUAGES)[number]): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('#login-email').fill(ADMIN_EMAIL);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  // The locale comes from localStorage, so confirm the shell really rendered it.
  await expect(page.getByRole('button', { name: /Language|Sprache/ })).toHaveText(language.code === 'de' ? 'EN' : 'DE');
}

async function adminProviders(request: APIRequestContext): Promise<AdminProviderRow[]> {
  const response = await request.get('/api/admin/providers');
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as AdminProviderRow[];
}

async function capture(page: Page, language: string, state: string, fullPage = true): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `admin-providers-${state}-${language}.png`), fullPage });
}

async function createProvider(request: APIRequestContext): Promise<string> {
  const created = await request.post('/api/admin/providers', {
    data: {
      name: PROVIDER_NAME,
      kind: 'openai-compatible',
      enabled: true,
      isDefault: true,
      config: {
        // Single-label http host: valid for an internal service and unreachable
        // here, which is what produces the error state.
        baseUrl: 'http://admin-providers-acceptance:1/v1',
        models: MODELS,
        defaultModel: MODELS[0]?.id,
        disabledModels: [MODELS[2]?.id],
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const credential = await request.post(`/api/admin/providers/${id}/credentials`, {
    data: { apiKey: `rotated-${randomUUID()}`, label: 'default' },
  });
  expect(credential.ok(), await credential.text()).toBeTruthy();

  const refreshed = await request.post(`/api/admin/providers/${id}/models/refresh`);
  expect(refreshed.ok(), await refreshed.text()).toBeTruthy();
  return id;
}

test.describe.configure({ mode: 'serial' });

for (const language of LANGUAGES) {
  test(`admin provider page: empty, filled, error and rotated (${language.code})`, async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: language.locale,
      colorScheme: 'light',
    });
    await context.addInitScript((code) => {
      try {
        localStorage.setItem('agent-tasks.lang', code);
      } catch {
        /* storage unavailable */
      }
    }, language.code);

    try {
      const page = await context.newPage();
      await signIn(page, language);

      // Empty state: a fresh instance has no provider at all.
      for (const provider of await adminProviders(context.request)) {
        const removed = await context.request.delete(`/api/admin/providers/${provider.id}`);
        expect(removed.ok(), `delete ${provider.name}: ${await removed.text()}`).toBeTruthy();
      }
      await page.goto('/admin/providers', { waitUntil: 'networkidle' });
      await expect(page.getByText(language.empty)).toBeVisible();
      await capture(page, language.code, 'empty');

      const id = await createProvider(context.request);
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: PROVIDER_NAME })).toBeVisible();
      await expect(page.getByText('opencode-go/glm-5')).toBeVisible();
      await expect(page.getByText('opencode-go/kimi-k2.5')).toBeVisible();
      await capture(page, language.code, 'filled');

      // Error state: the health check reports the unreachable endpoint and the
      // card shows the failure badge plus the checked timestamp.
      await page.getByRole('button', { name: language.health }).click();
      await expect(page.getByText(/unreachable|nicht erreichbar/)).toBeVisible({ timeout: 30_000 });
      await capture(page, language.code, 'error');

      // Rotated state: the dialog starts empty (the stored key is never echoed),
      // saving a new secret succeeds and the card still only reports "key set".
      await page.getByRole('button', { name: /Shared key|Gemeinsamer Schlüssel/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#shared-api-key')).toHaveValue('');
      await dialog.locator('#shared-api-key').fill(`rotated-${randomUUID()}`);
      await dialog.getByRole('button', { name: /^(Save|Speichern)$/ }).click();
      await expect(page.getByText(/Shared credential saved|Gemeinsamer Schlüssel gespeichert/)).toBeVisible();
      await capture(page, language.code, 'rotated');

      // Re-opening after the rotation proves again that no value is echoed.
      await page.getByRole('button', { name: /Shared key|Gemeinsamer Schlüssel/ }).click();
      await expect(page.getByRole('dialog').locator('#shared-api-key')).toHaveValue('');
      await page.keyboard.press('Escape');

      // The rotated key is the one the API keeps: exactly one shared credential.
      await expect.poll(async () => {
        const list = (await (await context.request.get('/api/admin/providers')).json()) as Array<{
          id: string;
          sharedCredential: boolean;
          personalCredentials: number;
        }>;
        const row = list.find((provider) => provider.id === id);
        return row ? `${row.sharedCredential}:${row.personalCredentials}` : 'missing';
      }).toBe('true:0');
    } finally {
      await context.close();
    }
  });
}
