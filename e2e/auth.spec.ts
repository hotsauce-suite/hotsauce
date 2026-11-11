import { expect, test } from './fixtures'

// These tests drive the sign-in form themselves.
test.use({ signedIn: false })

test('signs in through the dev form with an allowed email', async ({ page, user }) => {
  await page.goto('/sign-in')
  await page.getByTestId('dev-signin-email').fill(user.email)
  await page.getByTestId('dev-signin-submit').click()

  await expect(page).toHaveURL((url) => url.pathname.startsWith('/docs'))
  await expect(page.getByTestId('sidebar')).toBeVisible()

  // The session survives a reload; every other spec relies on page.goto after sign-in.
  await page.reload()
  await expect(page.getByTestId('sidebar')).toBeVisible()
})

test('rejects an email outside the allowed domain with a visible message', async ({
  page,
  request,
}) => {
  const outsider = 'visitor@example.com'

  await page.goto('/sign-in')
  await page.getByTestId('dev-signin-email').fill(outsider)
  await page.getByTestId('dev-signin-submit').click()

  await expect(page.getByRole('alert')).toContainText(/not allowed|example\.test/i)
  await expect(page).toHaveURL((url) => url.pathname.startsWith('/sign-in'))
  await expect(page.getByTestId('sidebar')).toHaveCount(0)

  // The domain lock is the server's, not just the form's (ARCHITECTURE §3.5).
  const res = await request.get('/api/me', { headers: { 'x-hearth-dev-user': outsider } })
  expect(res.status()).toBe(403)
  expect((await res.json()).error.code).toBe('domain_not_allowed')
})
