import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** Counts every ripple drawn from now on, even one that has already cleared itself. */
async function countRipples(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { ripples: number }
    w.ripples = 0
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.dataset.testid === 'switch-ripple') w.ripples++
    }).observe(document.body, { childList: true })
  })
  return () => page.evaluate(() => (window as unknown as { ripples: number }).ripples)
}

// docs/PLAN-switch-ripple.md: a ripple from the click when the tool changes, none under reduced motion.

test('a ripple spreads from the rail click when switching tools, and clears itself', async ({
  page,
}) => {
  await page.goto('/tasks')
  const rail = page.getByTestId('app-rail')
  await expect(rail.getByTestId('app-switch-tasks')).toHaveAttribute('aria-current', 'page')
  const drawn = await countRipples(page)

  await rail.getByTestId('app-switch-meetings').click()
  await expect(page.getByTestId('switch-ripple')).toHaveCount(1)
  expect(await drawn()).toBe(1)
  if (process.env.RIPPLE_SHOT) await page.screenshot({ path: process.env.RIPPLE_SHOT })
  await expect(page.getByTestId('switch-ripple')).toHaveCount(0)
  await expect(page.getByTestId('meetings-home')).toBeVisible()
})

test('no ripple when the device asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/tasks')
  const rail = page.getByTestId('app-rail')
  await expect(rail.getByTestId('app-switch-tasks')).toHaveAttribute('aria-current', 'page')
  const drawn = await countRipples(page)
  await rail.getByTestId('app-switch-meetings').click()
  await expect(page.getByTestId('meetings-home')).toBeVisible()
  expect(await drawn()).toBe(0)
})
