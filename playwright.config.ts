import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright drives the app through the Vite dev server (the same bundle the
 * Tauri window loads). Tauri-native commands are stubbed per-test via
 * window.__quillMock / __TAURI_INTERNALS__ shims, so no Rust process is needed.
 *
 * Unit tests live under src/test/ and belong to vitest; these end-to-end
 * specs live under e2e/, so the two runners never collide.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
