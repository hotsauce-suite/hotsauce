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
  // Keyboard: the right arrow moves on, the left goes back (once the stop has settled in).
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowRight')
  await expect(stop).toContainText('Today is your home page')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowLeft')
  await expect(stop).toContainText('Your apps')

  // To the end, one stop at a time: the last stop's button says Done.
  const total = Number((await stop.textContent())?.match(/1 of (\d+)/)?.[1])
  expect(total).toBeGreaterThan(8)
  for (let at = 2; at <= total; at++) {
    await page.getByTestId('tour-next').click()
    await expect(stop).toContainText(`${at} of ${total}`)
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
