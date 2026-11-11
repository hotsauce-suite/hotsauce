import { docUrl, expect, test, typeAtEnd, uid, waitForSave } from './fixtures'

// Runs only in the mobile-chromium project (Pixel 7 viewport, touch).

test('a phone can open a doc, type, and commit', async ({ page, api, user, waitForState }) => {
  const id = uid()
  const file = `docs/e2e-mobile-${id}.md`
  const text = `Typed on a phone ${id}`
  await api.writeFile(user.team, file, `# Mobile ${id}\n\nWritten on the go.\n`)

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor')).toBeVisible()
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('Written on the go.')

  await editor.tap()
  const saved = waitForSave(page, text)
  await typeAtEnd(page, text)
  expect((await saved).ok()).toBe(true)
  await waitForState('save-state', 'committed', { timeout: 3_000 })

  expect((await api.readFile(user.team, file))?.content).toContain(text)
})

test('a phone switches apps from the bottom tab bar, and nothing scrolls sideways', async ({
  page,
}) => {
  await page.goto('/docs')
  const bar = page.getByTestId('app-rail')
  await expect(bar).toBeVisible()
  // Flush with the bottom of the screen, once its slide-in has finished.
  const viewport = page.viewportSize()
  await expect
    .poll(async () => {
      const box = await bar.boundingBox()
      return box && Math.round(box.y + box.height)
    })
    .toBe(viewport?.height)

  await bar.getByTestId('app-switch-meetings').tap()
  await expect(page).toHaveURL(/\/meetings$/)
  await expect(page.getByTestId('meetings-home')).toBeVisible()
  await expect(bar.getByTestId('app-switch-meetings')).toHaveAttribute('aria-current', 'page')

  const widths = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="app-rail"] > div') as HTMLElement
    return {
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      bar: bar.scrollWidth,
      barBox: bar.clientWidth,
    }
  })
  expect(widths.page).toBeLessThanOrEqual(widths.viewport)
  expect(widths.bar).toBeLessThanOrEqual(widths.barBox)

  // The app's own sidebar is still in the drawer.
  await page.getByRole('button', { name: 'Open sidebar' }).first().tap()
  await expect(page.getByTestId('sidebar-app-name')).toHaveText('Hotsauce Meetings')
})
