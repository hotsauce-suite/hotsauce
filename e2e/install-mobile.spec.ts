import { expect, test } from './meetings-fixtures'

// docs/PLAN-install-and-settings.md, I6: on a phone the install bar shows on the first visit,
// Install opens the how-to sheet (headless Chromium offers no install dialog), and ✕ keeps it
// away after a reload. Nothing is wider than the screen.

test('on a phone, the install bar offers how to install and stays dismissed', async ({
  page,
  member,
}) => {
  expect(member.email).toBeTruthy()
  await page.goto('/notes')
  const bar = page.getByTestId('install-bar')
  await expect(bar).toContainText('on your phone')
  await page.getByTestId('install-bar-install').click()
  await expect(page.getByTestId('install-sheet')).toContainText('Add to Home Screen')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('install-sheet')).toHaveCount(0)

  await page.getByTestId('install-bar-dismiss').click()
  await expect(bar).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('apps-menu')).toBeVisible()
  await expect(page.getByTestId('install-bar')).toHaveCount(0)
})
