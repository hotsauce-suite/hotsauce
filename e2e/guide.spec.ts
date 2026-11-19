import { expect, signIn, test, uid } from './fixtures'

// docs/PLAN-tour-and-101.md J1 (second half): Settings → Hotsauce 101 lists every app and plays
// an app's loop from the built app, in place.

test.use({ signedIn: false })

test('Hotsauce 101 shows every app and plays its video', async ({ page }) => {
  await signIn(page, `guide-${uid()}@example.test`)
  await page.goto('/settings')
  await page.getByTestId('settings-nav-guide').click()
  await expect(page).toHaveURL(/\/settings\/101$/)
  const cards = page.getByTestId('guide-card')
  await expect(cards.first()).toBeVisible()
  expect(await cards.count()).toBeGreaterThanOrEqual(19)

  const docs = cards.filter({ has: page.getByRole('heading', { name: 'Docs', exact: true }) })
  await docs.getByTestId('guide-play').click()
  const video = docs.getByTestId('guide-video')
  await expect(video).toBeVisible()
  // The loop is served by the app itself and actually plays.
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0), {
      timeout: 10_000,
    })
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(video).toHaveCount(0)

  // Command-K's "What is Tables?" opens that card.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('What is Tables')
  await page.getByTestId('cmdk-command-guide-tables').click()
  await expect(page).toHaveURL(/\/settings\/101#tables$/)
  await expect(page.locator('#guide-tables')).toBeInViewport()
})
