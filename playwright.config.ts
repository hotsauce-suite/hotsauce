import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = 3999
const BASE_URL = `http://localhost:${PORT}`

// A fresh data dir per run, shared by the server and the test workers.
// Created here rather than in a globalSetup because Playwright starts the
// webServer before globalSetup runs. Workers load this file again but inherit
// the main process's env, so the check keeps one dir per run.
if (!process.env.HEARTH_E2E_DATA_DIR) {
  process.env.HEARTH_E2E_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-e2e-'))
}
const dataDir = process.env.HEARTH_E2E_DATA_DIR
// LocalHost keeps its bare repos here; e2e/fixtures.ts pushes "outside" edits to them.
const localHostDir = path.join(dataDir, 'remotes')
process.env.HEARTH_E2E_LOCAL_HOST_DIR = localHostDir

// A second, brand-new instance for the setup wizard (e2e/setup.spec.ts): Clerk sign-in with no
// keys yet, so it starts in setup mode. It runs under the container's entrypoint, which starts
// the server again when finishing setup restarts it.
export const SETUP_PORT = 3998
if (!process.env.HOTSAUCE_E2E_SETUP_DIR) {
  process.env.HOTSAUCE_E2E_SETUP_DIR = mkdtempSync(path.join(os.tmpdir(), 'hotsauce-setup-e2e-'))
}
const setupDir = process.env.HOTSAUCE_E2E_SETUP_DIR

// Meetings specs record from the microphone: Chromium grants it without a prompt and feeds
// it a fake device's tone (ARCHITECTURE §7.5). Headless in CI too.
// PLAYWRIGHT_CHROMIUM points at a preinstalled Chromium when the matching build isn't installed.
const fakeMedia = {
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
}

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Every worker writes to the one shared team space, whose commits the server serializes
  // (~350 ms each). Beyond two workers the queue alone outlasts the specs' 3 s save windows,
  // a load no real team makes, so the cap holds locally as well as in CI.
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: fakeMedia,
      },
      testIgnore: /mobile\.spec\.ts$/,
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], launchOptions: fakeMedia },
      testMatch: /mobile\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      // Runs the built server (apps/server/dist), which also serves apps/web/dist:
      // run `pnpm build` first.
      command: 'pnpm --filter @hearth/server start',
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        PORT: String(PORT),
        PUBLIC_URL: BASE_URL,
        AUTH_MODE: 'dev',
        HOST_KIND: 'local',
        ALLOWED_EMAIL_DOMAINS: 'example.test',
        // e2e/org-settings.spec.ts signs in as this admin.
        ADMIN_EMAILS: 'e2e-admin@example.test',
        ORG_NAME: 'Acme',
        CHAT_URL: 'https://chat.example.test',
        POLL_INTERVAL_MS: '1000',
        IDLE_COMMIT_MS: '500',
        DATA_DIR: dataDir,
        LOCAL_HOST_DIR: localHostDir,
        PUSH_SENDER: 'record',
        // Clips and kept audio on disk, never the R2 bucket a developer's .env.local names.
        AUDIO_STORE: 'local',
      },
    },
    {
      command: 'bash scripts/docker-entrypoint.sh node apps/server/dist/main.js',
      url: `http://localhost:${SETUP_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        PORT: String(SETUP_PORT),
        PUBLIC_URL: `http://localhost:${SETUP_PORT}`,
        AUTH_MODE: 'clerk',
        DATA_DIR: setupDir,
        LOCAL_HOST_DIR: path.join(setupDir, 'remotes'),
        AUDIO_STORE: 'local',
        PUSH_SENDER: 'record',
      },
    },
  ],
})
