import { expect, signIn, test } from './fixtures'

// Settings → Organization on a running instance. Only the brand is changed here, and put back:
// saving settings would need a restart, which the shared e2e server can't do mid-run.

const ADMIN = 'e2e-admin@example.test'

/** The app's main color as the page has it; empty while the page is reloading. */
const ember = (page: import('@playwright/test').Page) =>
  page
    .evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ember').trim())
    .catch(() => '')

test('members don’t see the organization settings', async ({ page, request }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
  await expect(page.getByTestId('settings-nav-general')).toBeVisible()
  await expect(page.getByTestId('settings-nav-workspace')).toHaveCount(0)
  // Nor can they reach its API.
  const res = await request.get('/api/admin/org/state', {
    headers: { 'x-hearth-dev-user': 'someone@example.test' },
  })
  expect(res.status()).toBe(403)
})

test('the Settings menu stays put while the page scrolls', async ({ page }) => {
  for (const size of [
    { width: 1280, height: 800 },
    // An iPad held upright: the narrowest window that still has the menu beside the page.
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(size)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
    const top = async (id: string) => (await page.getByTestId(id).boundingBox())?.y
    await page.getByRole('heading', { name: 'Weather' }).waitFor()
    const pane = page.getByTestId('settings-scroll')
    // How far the menu sits below the top of the scrolling area. The help strip is in the same
    // box, so it is checked by still being on screen.
    const below = (id: string) => async () =>
      Math.round(((await top(id)) ?? 0) - ((await top('settings-scroll')) ?? 0))
    // Wait out the page's entrance; the menu (search box first) rests 40px down, wherever the page is scrolled to.
    await expect.poll(below('settings-search')).toBe(40)
    await pane.evaluate((el) => el.scrollTo({ top: 300 }))
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(300)
    await expect.poll(below('settings-search')).toBe(40)
    await pane.evaluate((el) => el.scrollTo({ top: 700 }))
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(400)
    await expect.poll(below('settings-search')).toBe(40)
    await expect(page.getByTestId('settings-nav-general')).toBeInViewport()
    await expect(page.getByTestId('settings-reload')).toBeInViewport()
  }
})

test.describe('as an admin', () => {
  test.use({ signedIn: false })

  test('changes the brand, which the whole app picks up, then puts it back', async ({
    page,
    request,
  }) => {
    const admin = { 'x-hearth-dev-user': ADMIN }
    await signIn(page, ADMIN)
    await page.goto('/settings')
    await page.getByTestId('settings-nav-workspace').click()
    await expect(page).toHaveURL(/\/settings\/organization$/)
    await expect(page.getByTestId('org-summary')).toBeVisible()
    // Usage (docs/PLAN-app-usage.md): every app counted from history, one page.
    await page.getByTestId('settings-nav-usage').click()
    await expect(page).toHaveURL(/\/settings\/organization\/usage$/)
    await expect(page.getByTestId('usage-table')).toBeAttached()
    await page.getByTestId('settings-nav-people').click()
    await expect(page).toHaveURL(/\/settings\/organization\/people$/)
    // Env-configured values show as locked.
    await expect(page.getByTestId('allowed-domains')).toBeDisabled()
    // Invited people outside the domains are set here, not by env, so the admin can edit them.
    await expect(page.getByTestId('allowed-emails')).toBeEnabled()
    await page.getByTestId('settings-nav-brand').click()
    await expect(page).toHaveURL(/\/settings\/organization\/brand$/)

    try {
      await page.getByTestId('brand-primary').fill('#0f766e')
      await page.getByTestId('brand-section-save').click()
      // Brand changes need no restart: the page reloads in the new colors.
      await expect.poll(() => ember(page)).toBe('#0f766e')
      // Keys are never sent back, even to admins.
      const state = await (await request.get('/api/admin/org/state', { headers: admin })).json()
      expect(JSON.stringify(state.secrets)).not.toMatch(/sk_|sk-ant/)
    } finally {
      await request.put('/api/admin/org/brand', { headers: admin, data: { primary: '#c63d19' } })
    }
    await page.reload()
    await expect.poll(() => ember(page)).toBe('#c63d19')
  })
})
