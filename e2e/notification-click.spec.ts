import { expect, test } from './fixtures'

// docs/PLAN-notification-clicks.md R2: a notification click picks the open Hotsauce tab and asks
// it to move, and it moves in-app, never by a reload (which would end a recording). Run inside the real
// service worker; a headless browser can't click a system notification itself.
test('an open tab moves to a notification’s page in-app', async ({ page, context }) => {
  await page.goto('/today')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  // Marks the page, so a reload (which would end a recording) would show.
  await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true))

  const moved = await worker.evaluate(async () => {
    const sw = self as unknown as {
      clients: { matchAll(o: object): Promise<unknown[]> }
      pickTab(w: unknown[]): { postMessage(m: unknown): void } | null
      location: Location
    }
    const tab = sw.pickTab(await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    tab?.postMessage({
      type: 'hearth:navigate',
      url: new URL('/briefcast', sw.location.origin).href,
    })
    return !!tab
  })

  expect(moved).toBe(true)
  await expect(page).toHaveURL(/\/briefcast$/)
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true)
})
