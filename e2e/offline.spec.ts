import type { Page } from '@playwright/test'
import { docText, docUrl, expect, test, typeAtEnd, uid } from './fixtures'

// docs/PLAN-offline.md, step A: the critical journeys with the network cut (context.setOffline).

/** The service worker controls the page, so every screen is on the device (A1). */
async function offlineReady(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, {
    timeout: 30_000,
  })
}

test('a doc edited offline is kept on the device, survives a reload, and is saved when back (A2.5, A3.5, A4.5)', async ({
  page,
  context,
  api,
  user,
  waitForState,
}) => {
  const file = `docs/offline-${uid()}.md`
  const line = `Written on a plane ${uid()}`
  await api.writeFile(user.team, file, '# Offline\n\nStart.\n')
  await page.goto(docUrl(user.team, file))
  await expect(docText(page)).toContainText('Start.')
  await offlineReady(page)

  await context.setOffline(true)
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await expect(page.getByTestId('assistant-open')).toBeDisabled()

  // In the doc's text: a team doc's comment box sits under it in the same area.
  await docText(page).getByText('Start.').click()
  await typeAtEnd(page, line)
  await waitForState('save-state', 'offline')
  await expect(page.getByTestId('save-state')).toHaveText('Saved on this device')

  // Reload with no connection: the app opens as this member and the doc from the device.
  await page.reload()
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await expect(docText(page)).toContainText(line)
  await waitForState('save-state', 'offline')
  expect((await api.readFile(user.team, file))?.content).not.toContain(line)
  // Keep typing after the offline start: that waits too, and nothing blocks the reconnect.
  const more = `And more after the reload ${uid()}`
  // In the doc's text: a team doc's comment box sits under it in the same area.
  await docText(page).getByText('Start.').click()
  await typeAtEnd(page, more)
  await waitForState('save-state', 'offline')

  // Back online: the app reconnects by itself and sends it.
  await context.setOffline(false)
  await expect(page.getByTestId('offline-bar')).toBeHidden({ timeout: 20_000 })
  await waitForState('save-state', 'committed', { timeout: 20_000 })
  await expect.poll(async () => (await api.readFile(user.team, file))?.content).toContain(line)
  expect((await api.readFile(user.team, file))?.content).toContain(more)
})

test('a screen never opened before still opens offline (A1.2, A3.4)', async ({ page, context }) => {
  await page.goto('/docs')
  await offlineReady(page)
  await context.setOffline(true)
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await expect(page.getByTestId('offline-empty')).toContainText('Not available offline yet')
  await expect(page.getByTestId('offline-bar')).toBeVisible()
})

test('Sign out pressed offline signs out for real once the connection is back (S6)', async ({
  page,
  context,
}) => {
  await page.goto('/docs')
  await offlineReady(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await page.goto('/settings')
  await page.getByTestId('settings-sign-out').click()
  await expect(page).toHaveURL(/\/sign-in/)
  await context.setOffline(false)
  // Back online: still signed out, and the server agrees.
  await page.goto('/docs')
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 20_000 })
  const me = await page.evaluate(async () => (await fetch('/api/me')).status)
  expect(me).toBe(401)
})

test('another member on the same browser never sees what the last one typed offline (S7)', async ({
  page,
  context,
  api,
  user,
}) => {
  const file = `docs/shared-${uid()}.md`
  const secret = `Private words ${uid()}`
  await api.writeFile(user.team, file, '# Shared\n\nStart.\n')
  await page.goto(docUrl(user.team, file))
  await expect(docText(page)).toContainText('Start.')
  await offlineReady(page)
  await context.setOffline(true)
  // In the doc's text: a team doc's comment box sits under it in the same area.
  await docText(page).getByText('Start.').click()
  await typeAtEnd(page, secret)
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'offline')
  await page.goto('/settings')
  await page.getByTestId('settings-sign-out').click()
  await expect(page).toHaveURL(/\/sign-in/)

  // Someone else signs in on this browser, then goes offline and opens the same doc.
  await context.setOffline(false)
  const other = `e2e-other-${uid()}@example.test`
  // Still on the sign-in page from the sign-out.
  await page.getByTestId('dev-signin-email').fill(other)
  await page.getByTestId('dev-signin-submit').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
  // Once the app knows who they are (what an offline start opens as).
  await expect(page.getByTestId('account-menu')).toHaveAttribute('aria-label', `Account: ${other}`)
  await context.setOffline(true)
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('offline-empty')).toBeVisible()
  await expect(page.getByText(secret)).toHaveCount(0)
  await page.goto('/docs/kept')
  await expect(page.getByTestId('kept-empty')).toBeVisible()
})

test('the MCP sign-in addresses still reach the server once the app works offline', async ({
  page,
}) => {
  await page.goto('/')
  await offlineReady(page)
  // A browser opening the discovery address gets the server's JSON, not the app's page.
  const res = await page.goto('/.well-known/oauth-authorization-server')
  expect(res?.headers()['content-type']).toContain('application/json')
  expect(res?.fromServiceWorker()).toBe(false)
})
