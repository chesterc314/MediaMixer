import { defineConfig } from '@playwright/test';

const port = 3108;

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
  },
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
