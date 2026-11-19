import { expect, signIn, test, uid } from './fixtures'

// The first-run tour (docs/PLAN-tour-and-101.md, J1): a new member gets the welcome card on Today,
// walks the tour to the end, doesn't see it again after a reload, and replays it from the menu.

test.use({ signedIn: false })

test('J1: the tour greets a new member once and replays from the account menu', async ({
  page,
}) => {
  await signIn(page, `e2e-tour-${uid()}@example.test`, { tour: true })
  await page.goto('/today')

  const welcome = page.getByTestId('tour-welcome')
  await expect(welcome).toBeVisible()
  await page.getByTestId('tour-start').click()

  const stop = page.getByTestId('tour-stop')
  await expect(stop).toContainText('Your apps')
  // Keyboard: the right arrow moves on, the left goes back.
  await page.keyboard.press('ArrowRight')
  await expect(stop).toContainText('Today is your home page')
  await page.keyboard.press('ArrowLeft')
  await expect(stop).toContainText('Your apps')

  // To the end: the last stop's button says Done.
  for (let i = 0; i < 20; i++) {
    const next = page.getByTestId('tour-next')
    if ((await next.textContent())?.trim() === 'Done') break
    await next.click()
  }
  await expect(page.getByTestId('tour-next')).toHaveText('Done')
  await page.getByTestId('tour-next').click()
  await expect(stop).toHaveCount(0)

  await page.reload()
  await expect(page.getByTestId('today')).toBeVisible()
  await expect(page.getByTestId('today-greeting')).toBeVisible()
  await expect(welcome).toHaveCount(0)

  await page.getByTestId('account-menu').click()
  await page.getByTestId('menu-tour').click()
  await expect(welcome).toBeVisible()
  await expect(page).toHaveURL((url) => url.pathname === '/today' && url.search === '')
  await page.getByTestId('tour-not-now').click()
  await expect(welcome).toHaveCount(0)
})
