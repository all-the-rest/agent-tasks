import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
          exclude: ['**/test/integration/**', 'apps/web/**'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
