import { expect, test } from './fixtures'

// docs/PLAN-ai-themes.md: describe a look, preview it, keep it, and it survives a reload.

test('a theme made from a description restyles the app and stays after a reload', async ({
  page,
}) => {
  await page.goto('/settings')
  const html = page.locator('html')
  const paper = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    )
  const before = await paper()

  await page.getByTestId('theme-prompt').fill('a calm midnight blue')
  await page.getByTestId('theme-make').click()
  await expect(page.getByTestId('theme-preview')).toContainText('Previewing Midnight Harbor')
  await expect(html).toHaveAttribute('data-theme', 'custom')
  expect(await paper()).not.toBe(before)

  // A follow-up changes the preview.
  await page.getByTestId('theme-prompt').fill('make it a retro terminal instead')
  await page.getByTestId('theme-make').click()
  await expect(page.getByTestId('theme-preview')).toContainText('Green Phosphor')

  await page.getByTestId('theme-keep').click()
  await expect(page.getByTestId('own-theme')).toContainText('Green Phosphor')
  const kept = await paper()

  // Painted before the app loads, so there is no flash of the old look.
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'custom')
  expect(await paper()).toBe(kept)
  await expect(page.getByTestId('own-theme').getByRole('radio')).toBeChecked()

  // Deleting it returns to the device's look.
  await page.getByTestId('own-theme').getByRole('button', { name: 'Delete' }).click()
  await page.getByTestId('own-theme').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('own-theme')).toHaveCount(0)
  await expect(html).not.toHaveAttribute('data-theme', /.+/)
})
