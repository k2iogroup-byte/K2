import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const apiPort = 4000;
const webPort = 3000;
const emailOutbox = path.resolve(process.cwd(), 'apps/api/.email-outbox');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'npm run start -w @k2/api',
      cwd: '../..',
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        APP_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(apiPort),
        EMAIL_DELIVERY: 'capture',
        EMAIL_OUTBOX_PATH: emailOutbox,
      },
    },
    {
      command: 'npm run start -w @k2/web',
      cwd: '../..',
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
