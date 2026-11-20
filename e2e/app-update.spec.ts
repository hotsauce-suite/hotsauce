import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// An open window picks up a new release on its own, at a safe moment
// (docs/PLAN-reload-after-updates.md R2 to R4). The server is made to report another release.

// The service worker can answer requests the test's routes would miss: keep it out.
test.use({ serviceWorkers: 'block' })

// A spec can end while its page is still polling /api/health through the route below; let those
// last requests go quietly instead of failing whichever spec the worker runs next.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

async function serverReports(page: Page, version: string) {
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, version } })
  })
}

/** Marks this page load, so a reload shows as the mark being gone. */
async function markLoad(page: Page) {
  await page.evaluate(() => {
    ;(window as unknown as { __sameLoad?: boolean }).__sameLoad = true
  })
}

const sameLoad = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad === true)

/** The window going to the background (a safe moment), as the browser would say it. */
async function goToBackground(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

test('reloads into a new release when moving to another page', async ({ page }) => {
  await serverReports(page, '99.0.0')
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await markLoad(page)
  // The first check runs a few seconds after the page opens.
  await page.waitForTimeout(6_000)
  const reloaded = page.waitForEvent('load', { timeout: 20_000 })
  await page.getByTestId('app-rail').getByTestId('app-switch-meetings').click()
  await expect(page).toHaveURL(/\/meetings$/)
  await reloaded
  expect(await sameLoad(page)).toBe(false)
  await expect(page.getByTestId('meetings-home')).toBeVisible()

  // Back on the old build (this test's build is still the old one): no second reload.
  await markLoad(page)
  await page.waitForTimeout(6_000)
  await page.getByTestId('app-rail').getByTestId('app-switch-tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await page.waitForTimeout(3_000)
  expect(await sameLoad(page)).toBe(true)
})

test('never reloads while something is being typed', async ({ page }) => {
  await serverReports(page, '99.0.0')
  await page.goto('/tasks')
  await page.getByTestId('tasks-add').click()
  await page.getByTestId('quick-add-input').fill('Call the lab')
  await markLoad(page)
  await page.waitForTimeout(6_000)
  await goToBackground(page)
  await page.waitForTimeout(3_000)
  expect(await sameLoad(page)).toBe(true)
  await expect(page.getByTestId('quick-add-input')).toHaveValue('Call the lab')
})

test('does nothing when the server runs this build', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await markLoad(page)
  await page.waitForTimeout(6_000)
  await goToBackground(page)
  await page.waitForTimeout(2_000)
  expect(await sameLoad(page)).toBe(true)
})

test('reloads when the window goes to the background', async ({ page }) => {
  await serverReports(page, '99.0.0')
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await markLoad(page)
  await page.waitForTimeout(6_000)
  const reloaded = page.waitForEvent('load', { timeout: 20_000 })
  await goToBackground(page)
  await reloaded
  expect(await sameLoad(page)).toBe(false)
})

test('says it updated after a reload brought the new release', async ({ page }) => {
  const version = readFileSync(
    path.join(import.meta.dirname, '..', 'HOTSAUCE_VERSION'),
    'utf8',
  ).trim()
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  // What the page remembers when it reloads itself for a release (lib/appUpdate RELOAD_KEY).
  await page.evaluate(
    (v) => sessionStorage.setItem('hotsauce:update-reload', JSON.stringify({ version: v, at: 1 })),
    version,
  )
  await page.reload()
  await expect(page.getByText(`updated to ${version}`)).toBeVisible()
  // Once.
  await page.reload()
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await expect(page.getByText(`updated to ${version}`)).toHaveCount(0)
})
