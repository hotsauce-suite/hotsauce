import { expect, test } from './fixtures'

// An upright iPad Air with touch (docs/PLAN-ipad.md, slice 3).
test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

test('T6: a finger hides the sidebar and brings it back', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('sidebar-app-name')).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  const hide = page.getByTestId('hide-sidebar')
  // In the sidebar's top corner, where a finger finds it, not pushed out of the frame.
  await expect(hide).toBeInViewport()
  expect((await hide.boundingBox())?.y).toBeLessThan(80)
  await hide.tap()
  await expect(page.getByTestId('sidebar-app-name')).toBeHidden()
  const strip = page.getByTestId('show-sidebar')
  expect((await strip.boundingBox())?.width).toBeGreaterThanOrEqual(28)
  await strip.tap()
  await expect(page.getByTestId('sidebar-app-name')).toBeVisible()
})

test('T7: on a whiteboard the Ask button sits above the board’s own controls', async ({ page }) => {
  await page.goto('/tasks')
  const ask = page.getByTestId('assistant-open')
  const elsewhere = await ask.boundingBox()
  expect(1180 - ((elsewhere?.y ?? 0) + (elsewhere?.height ?? 0))).toBeLessThan(24)
  await page.goto('/boards/team/01JC4BRD000000000000000001')
  await expect(ask).toBeVisible()
  const onBoard = await ask.boundingBox()
  expect(1180 - ((onBoard?.y ?? 0) + (onBoard?.height ?? 0))).toBeGreaterThanOrEqual(72)
})
