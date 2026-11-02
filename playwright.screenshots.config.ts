import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/screenshots',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'off',
    video: 'off',
  },
  outputDir: 'test-results/ui-screenshots',
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 950 } },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Galaxy A55'] },
    },
  ],
});
