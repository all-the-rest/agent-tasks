import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E against the real compose stack.
 *
 * The stack (web on :8080, API behind /api, worker, Postgres) is started by
 * `docker compose` before the suite runs — see `.github/workflows/ci.yml` and
 * `TESTING.md`. There is deliberately no `webServer` block: Playwright must not
 * bootstrap a second, differently configured instance.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // The suite talks to one shared stack; independent state is created per test,
  // not by running tests concurrently.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
