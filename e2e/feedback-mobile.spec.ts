import { expect, test } from './meetings-fixtures'

// Send feedback on a phone: reached from the account menu, and nothing wider than the screen.

test('on a phone, Send feedback opens from the account menu and fits', async ({ page, member }) => {
  expect(member.email).toBeTruthy()
  await page.goto('/notes')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('menu-feedback').click()
  await expect(page.getByTestId('feedback-form')).toBeVisible()
  await page.getByTestId('feedback-kind-idea').check({ force: true })
  await page
    .getByTestId('feedback-text')
    .fill('It would help to pin a doc to the top of the team space for everyone.')
  await page.getByTestId('feedback-send').click()
  await expect(page.getByTestId('feedback-sent')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
