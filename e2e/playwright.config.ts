import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// The tests reach the same database the server does — to move a clock forward, and to close the
// pool at the end — so this process needs the same environment the server is started with.
process.loadEnvFile(join(import.meta.dirname, '..', '.env.e2e'))

/**
 * The whole product in a real browser, against a real server and a real database.
 *
 * Served the way it ships: one origin, the built app handed out by the same process that answers
 * the API. The development arrangement — Vite on its own port — is a second shape that nothing in
 * production ever runs, and a suite that only ever met that shape would say nothing about what a
 * person loads.
 */
const ORIGIN = 'http://localhost:3199'

export default defineConfig({
  testDir: '.',
  // A journey holds a machine, a conversation and a person's session together; two of them at
  // once on one database would be two stories written into the same page.
  workers: 1,
  fullyParallel: false,
  // A failing journey that passes on a second try is a journey that fails.
  retries: 0,

  // A journey here is a journey — two people signing in for real, a machine connecting, work
  // moving between them. Playwright's default of 30 seconds is sized for a test that presses one
  // button, and a suite that fails on the length of what it walks fails for a reason that has
  // nothing to do with the product.
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: {
    // Its output goes to a file because the letters go there: with no mail provider the server
    // writes each code to its log, and that file is this suite's inbox.
    command:
      'pnpm --filter @handover/web build && node --env-file=../../.env.e2e src/main.ts > ../../e2e/letters.log 2>&1',
    cwd: '../apps/server',
    url: `${ORIGIN}/auth/credentials`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
