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

// An admin, so Settings → Organization shows every section (its hidden logo inputs once
// made the page scroll).
test.use({ signedIn: false })

test('on a phone, every app fits the window and the frame never scrolls', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, 'e2e-admin@example.test')
  for (const path of PAGES) {
    await page.goto(path)
    await expect(page.getByTestId('app-rail')).toBeVisible()
    const frame = await page.evaluate(() => ({
      scrollHeight: (document.scrollingElement as HTMLElement).scrollHeight,
      innerHeight,
    }))
    expect(frame.scrollHeight, `${path} is taller than the window`).toBeLessThanOrEqual(
      frame.innerHeight,
    )

    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    )
    // Scrolling hard past the end of the page leaves the rail where it was.
    const before = await page.getByTestId('app-rail').boundingBox()
    await page.mouse.move(200, 400)
    await page.mouse.wheel(0, 5000)
    expect(await page.evaluate(() => scrollY), path).toBe(0)
    expect((await page.getByTestId('app-rail').boundingBox())?.y, path).toBe(before?.y)
  }
})
