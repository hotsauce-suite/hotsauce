import { expect, signIn, test } from './fixtures'

// The shell is one frame the height of the window: panes scroll inside it, the page never
// does. Scrolling past the end of a pane must not drag the rail and sidebar up with it.

const PAGES = [
  '/docs',
  '/meetings',
  '/settings',
  '/settings/organization',
  '/feedback',
  '/dictate',
  '/clips',
  '/tasks',
  '/notes',
  '/boards',
  '/people',
  '/today',
  '/files',
  '/forms',
  '/checkins',
  '/tables',
  '/links',
  '/briefcast',
  '/pages',
]

// A laptop, and an iPad upright and on its side.
const WINDOWS = [
  { width: 1280, height: 800 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
]

// An admin, so Settings → Organization shows every section (its hidden logo inputs once
// made the page scroll).
test.use({ signedIn: false })

for (const size of WINDOWS)
  test(`at ${size.width}×${size.height}, every app fits the window and the frame never scrolls`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(size)
    await signIn(page, 'e2e-admin@example.test')
    for (const path of PAGES) {
      await page.goto(path)
      await expect(page.getByTestId('app-rail')).toBeVisible()
      const frame = await page.evaluate(() => ({
        scrollHeight: (document.scrollingElement as HTMLElement).scrollHeight,
        innerHeight,
      }))
      expect(
        frame.scrollHeight,
        `${path} at ${size.width}px is taller than the window`,
      ).toBeLessThanOrEqual(frame.innerHeight)

      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      )
      // Scrolling hard past the end of the page leaves the rail where it was.
      const before = await page.getByTestId('app-rail').boundingBox()
      await page.mouse.move(700, 400)
      await page.mouse.wheel(0, 5000)
      expect(await page.evaluate(() => scrollY), path).toBe(0)
      expect((await page.getByTestId('app-rail').boundingBox())?.y, path).toBe(before?.y)
    }
  })

test('pages outside the app still scroll the page', async ({ page }) => {
  // Sign-in stands in for public forms, booking pages and shared links: no shell, and a
  // short window must still reach the bottom.
  await page.setViewportSize({ width: 600, height: 240 })
  await page.goto('/sign-in')
  await expect(page.getByTestId('dev-signin-submit')).toBeAttached()
  const scrolled = await page.evaluate(() => {
    window.scrollTo(0, 10_000)
    return {
      scrollY,
      room: (document.scrollingElement as HTMLElement).scrollHeight - innerHeight,
    }
  })
  expect(scrolled.room).toBeGreaterThan(0)
  expect(scrolled.scrollY).toBe(scrolled.room)
})
