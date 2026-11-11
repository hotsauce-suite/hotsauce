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
  await expect(page.getByRole('heading', { name: /Connect Claude/ })).toBeVisible()
  await expect(page.getByTestId('org-settings-link')).toHaveCount(0)
  // Nor can they reach its API.
  const res = await request.get('/api/admin/org/state', {
    headers: { 'x-hearth-dev-user': 'someone@example.test' },
  })
  expect(res.status()).toBe(403)
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
    await page.getByTestId('org-settings-link').click()
    await expect(page).toHaveURL(/\/settings\/organization$/)
    await expect(page.getByTestId('org-summary')).toBeVisible()
    // Env-configured values show as locked.
    await expect(page.getByTestId('allowed-domains')).toBeDisabled()

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
