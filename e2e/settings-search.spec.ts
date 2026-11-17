import { expect, test } from './fixtures'

// docs/PLAN-settings-search.md S1, S4, S5: search Settings and land on the section.

test('searching Settings opens the section, scrolled into view and marked', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
  const box = page.getByRole('searchbox', { name: 'Search settings' })
  await box.fill('forecast')
  const result = page.getByTestId('settings-search-result')
  await expect(result).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Account' })).toBeHidden()
  await result.click()
  await expect(box).toHaveValue('')
  const weather = page.getByTestId('settings-weather')
  await expect(weather).toHaveAttribute('data-settings-found', '')
  await expect(weather).toBeInViewport()

  // On another page: Enter opens the first result there.
  await box.fill('calendars')
  await box.press('Enter')
  await expect(page).toHaveURL(/\/settings\/connections$/)
  await expect(page.getByRole('heading', { name: 'Calendars' })).toBeVisible()
})

test('on a phone the search box sits above the Settings tabs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/settings')
  const box = page.getByRole('searchbox', { name: 'Search settings' })
  await expect(box).toBeVisible()
  const boxBottom = (await box.boundingBox())?.y ?? 0
  const tabsTop = (await page.getByTestId('settings-nav').boundingBox())?.y ?? 0
  expect(boxBottom).toBeLessThan(tabsTop)
  await box.fill('dark')
  await expect(page.getByTestId('settings-search-result').first()).toBeVisible()
})
