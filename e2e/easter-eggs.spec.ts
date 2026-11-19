import { expect, test } from './fixtures'

// docs/PLAN-easter-eggs.md: the critical bits in a real browser.

test('an address no page owns shows the lost-sauce page, and its button goes to Docs', async ({
  page,
}) => {
  await page.goto('/no-such-place')
  await expect(page.getByTestId('not-found')).toContainText('This page got too spicy and left.')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await page.getByTestId('not-found-home').click()
  await expect(page).toHaveURL(/\/docs$/)
})

test('the Konami code rains peppers that clear themselves; "more heat" turns on Ghost Pepper', async ({
  page,
}) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('app-rail')).toBeVisible()
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  for (const key of [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
    'b',
    'a',
  ]) {
    await page.keyboard.press(key)
  }
  await expect(page.getByTestId('pepper-shower')).toBeAttached()
  await expect(page.getByTestId('pepper-shower')).toHaveCount(0, { timeout: 5000 })

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('more heat')
  await page.getByTestId('cmdk-command-egg-more-heat').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom')
  // Survives a reload with no flash back to the usual look.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom')
  await expect(page.getByTestId('app-rail')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('cmdk-input').fill('less heat')
  await page.getByTestId('cmdk-command-egg-less-heat').click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'custom')
})
