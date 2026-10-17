import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real browser against the built web app and a real API on a
 * throw-away database (the API test database, re-seeded with the DEMO institute).
 *
 * Set E2E_BASE_URL to test an already-running deployment instead (one address serving
 * both the web app and the API, freshly seeded with SEED_DEMO=true); nothing is started
 * or reset then.
 */
const API_PORT = 3100;
const WEB_PORT = 4173;
const EXTERNAL = process.env.E2E_BASE_URL;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://qra:qra@localhost:55432/qr_attendance_test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: EXTERNAL ? undefined : './e2e/global-setup.ts',
  outputDir: './e2e/.results',
  use: {
    baseURL: EXTERNAL ?? `http://localhost:${WEB_PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 820 },
    trace: 'retain-on-failure',
  },
  webServer: EXTERNAL ? undefined : [
    {
      command: 'npx tsx src/server.ts',
      cwd: '../api',
      port: API_PORT,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        JWT_SECRET: 'e2e-secret-that-is-long-enough-123456',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npx vite build && npx vite preview --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
