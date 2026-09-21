import { defineConfig } from '@playwright/test';

const PORT = 5199;

// Locally we drive the Chrome already installed on the machine (no browser download).
// CI installs Playwright's Chromium (`playwright install chromium`) and sets CI=1.
const channel = process.env['PW_CHANNEL'] ?? (process.env['CI'] ? undefined : 'chrome');

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // Generous: with the demo company loading in many tests at once, a busy machine can be slow to settle. A real bug fails every time; a slow moment does not.
  expect: { timeout: 10_000 },
  retries: 1,
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...(channel ? { channel } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --filter @minimalerp/web exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
