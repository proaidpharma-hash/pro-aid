import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real app against the real database rules (local Postgres + the local Supabase stand-in).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, browserName: 'chromium' }, testMatch: /phone\.spec\.ts/ },
  ],
  webServer: [
    { command: 'node ../tools/reset-dev-db.mjs proaid_test && PGDATABASE=proaid_test PORT=54322 STORAGE_DIR=/tmp/proaid-test-storage node ../tools/local-supabase.mjs', port: 54322, reuseExistingServer: false, timeout: 30_000 },
    { command: 'VITE_SUPABASE_URL=http://localhost:54322 VITE_SUPABASE_ANON_KEY=local-anon-key npx vite --port 5174 --strictPort', port: 5174, reuseExistingServer: false, timeout: 30_000 },
  ],
});
