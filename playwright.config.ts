// The packaged-app smoke test (e2e/packaged.spec.ts, docs/RELEASING.md §6.1). It drives the built Principia.app, not the
// dev build: `npm run pack:dir` first, then `npm run smoke:packaged`. Unit tests stay in vitest (src/**/*.test.ts).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  // one app, one window: the steps share it and run in order
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list'
})
