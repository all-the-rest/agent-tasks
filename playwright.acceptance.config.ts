import { defineConfig, devices } from '@playwright/test';

/**
 * Acceptance captures that mutate shared admin state (the provider list) and
 * therefore run separately from the read-mostly UI-review set:
 *   E2E_BASE_URL=http://localhost:8080 pnpm test:screenshots:acceptance
 *
 * One desktop project, one worker — the states are sequential by design.
 */
export default defineConfig({
  testDir: './tests/acceptance',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'off',
    video: 'off',
  },
  outputDir: 'test-results/acceptance',
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
