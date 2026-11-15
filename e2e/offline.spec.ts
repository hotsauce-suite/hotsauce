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

  await page.getByTestId('editor-content').click()
  await typeAtEnd(page, line)
  await waitForState('save-state', 'offline')
  await expect(page.getByTestId('save-state')).toHaveText('Saved on this device')

  // Reload with no connection: the app opens as this member and the doc from the device.
  await page.reload()
  await expect(page.getByTestId('offline-bar')).toBeVisible()
  await expect(docText(page)).toContainText(line)
  await waitForState('save-state', 'offline')
  expect((await api.readFile(user.team, file))?.content).not.toContain(line)

  // Back online: the app reconnects by itself and sends it.
  await context.setOffline(false)
  await expect(page.getByTestId('offline-bar')).toBeHidden({ timeout: 20_000 })
  await waitForState('save-state', 'committed', { timeout: 20_000 })
  await expect.poll(async () => (await api.readFile(user.team, file))?.content).toContain(line)
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
