import { docUrl, expect, test, uid } from './fixtures'

// The app rail (ARCHITECTURE §6 shell): switch apps in one click, land where you left each,
// Settings, Acme Chat in a new tab, and the account menu's Sign out.

test('switches apps from the rail and returns to where each was', async ({ page, api, user }) => {
  const id = uid()
  const file = `docs/e2e-rail-${id}.md`
  await api.writeFile(user.team, file, `# Rail ${id}\n\nWhere I left off.\n`)

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Where I left off.')
  const rail = page.getByTestId('app-rail')
  await expect(rail.getByTestId('app-switch-docs')).toHaveAttribute('aria-current', 'page')

  await rail.getByTestId('app-switch-meetings').click()
  await expect(page).toHaveURL(/\/meetings$/)
  await expect(page.getByTestId('meetings-home')).toBeVisible()
  await expect(rail.getByTestId('app-switch-meetings')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('sidebar-app-name')).toHaveText('Hotsauce Meetings')

  // Back goes to the doc; the rail follows.
  await page.goBack()
  await expect(page.getByTestId('editor-content')).toContainText('Where I left off.')
  await expect(rail.getByTestId('app-switch-docs')).toHaveAttribute('aria-current', 'page')

  await rail.getByTestId('app-switch-dictate').click()
  await expect(page).toHaveURL(/\/dictate$/)
  await rail.getByTestId('settings-link').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(rail.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page')
  await expect(rail.locator('[aria-current="page"]')).toHaveCount(1)

  // Docs lands on the doc it was showing, not on Settings.
  await rail.getByTestId('app-switch-docs').click()
  await expect(page).toHaveURL((url) => url.pathname === docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Where I left off.')
})

test('opens Acme Chat in a new tab', async ({ page, context }) => {
  await context.route('https://chat.example.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Acme Chat</title>' }),
  )
  await page.goto('/docs')
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByTestId('app-link-chat').click(),
  ])
  await expect(popup).toHaveURL(/^https:\/\/chat\.example\.test\/?$/)
  // The app's tab stays where it was.
  await expect(page).toHaveURL(/\/docs$/)
})

test('Cmd-K jumps to an app by name', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('go to dictate')
  await page.getByTestId('cmdk-app-dictate').click()
  await expect(page).toHaveURL(/\/dictate$/)
})

test('the account menu shows the email and opens Settings, where Sign out is', async ({
  page,
  user,
}) => {
  await page.goto('/docs')
  await page.getByTestId('account-menu').click()
  await expect(page.getByTestId('account-email')).toHaveText(user.email)
  await expect(page.getByTestId('sign-out')).toHaveCount(0)
  await page.getByTestId('menu-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByTestId('settings-email')).toHaveText(user.email)
  await page.getByTestId('settings-sign-out').click()
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByTestId('app-rail')).toHaveCount(0)
})

test('the desktop rail icons are half again the phone bar size, and every label fits', async ({
  page,
}) => {
  await page.goto('/docs')
  const rail = page.getByTestId('app-rail')
  await expect(rail).toBeVisible()
  const railBox = await rail.boundingBox()
  const icon = await rail.getByTestId('app-switch-docs').locator('svg').first().boundingBox()
  // 20px on the phone bar; 30px on the desktop rail (Morgan, Nov 13: "maybe 50%").
  expect(icon?.width).toBeCloseTo(30, 1)
  expect(Math.round(railBox?.width ?? 0)).toBeGreaterThanOrEqual(68)
  // No label is cut off: each one's text fits inside its item.
  const clipped = await rail
    .locator('a span.truncate')
    .evaluateAll((spans) =>
      spans.filter((s) => s.scrollWidth > s.clientWidth).map((s) => s.textContent),
    )
  expect(clipped).toEqual([])
})

test('a short window fades the rail out at the bottom until it is scrolled to the end', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto('/docs')
  const list = page.getByTestId('rail-apps')
  await expect(list).toHaveAttribute('data-more', 'true')
  await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect(list).not.toHaveAttribute('data-more')
  await page.setViewportSize({ width: 1280, height: 2000 })
  await list.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(list).not.toHaveAttribute('data-more')
})
