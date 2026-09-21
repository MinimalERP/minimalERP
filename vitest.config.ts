import { defineConfig } from 'vitest/config';

// Two projects:
//   unit — fast, no I/O. Runs on every `pnpm test`.
//   db   — real PostgreSQL (embedded, no Docker) with migrations applied. `pnpm test:db`.
// Phase 3 will add a jsdom project for apps/web component tests.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/db-tests/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          include: ['packages/db-tests/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/db-tests/src/harness/globalSetup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
