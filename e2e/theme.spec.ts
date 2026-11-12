import { expect, test } from './fixtures'

test('a member picks light or dark in Settings, and it sticks across reloads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/settings')
  const html = page.locator('html')
  await expect(page.getByTestId('theme-system')).toBeChecked()
  await expect(html).not.toHaveAttribute('data-theme')

  await page.getByText('Dark', { exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const dark = await paper()

  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByTestId('theme-dark')).toBeChecked()

  await page.getByText('Light', { exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  expect(await paper()).not.toBe(dark)

  // Match my device follows the system again.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByText('Match my device').click()
  await expect(html).not.toHaveAttribute('data-theme')
  expect(await paper()).toBe(dark)
})

test('the Settings link shows a gear', async ({ page }) => {
  await page.goto('/docs')
  const path = await page.getByTestId('settings-link').first().locator('path').getAttribute('d')
  expect(path).toMatch(/^M6\.74 3\.32/)
})
