import { expect, test } from './fixtures'

// An iPad (docs/PLAN-ipad.md, T4): the browser can record the camera but not the screen.
test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

test('T4: where the screen can’t be recorded, Clips starts on Camera only', async ({ page }) => {
  await page.addInitScript(() => {
    // iPadOS Safari has no getDisplayMedia.
    Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { value: undefined })
  })
  await page.goto('/clips/new')
  await expect(page.getByTestId('clip-mode-camera').locator('input')).toBeChecked()
  await expect(page.getByTestId('clip-mode-screen_camera').locator('input')).toBeDisabled()
  await expect(page.getByTestId('clip-mode-screen').locator('input')).toBeDisabled()
  await expect(page.getByTestId('clip-no-screen')).toContainText('can’t record its screen')
  await expect(page.getByTestId('camera-preview').locator('video')).toBeVisible()
  await expect(page.getByTestId('clip-start')).toBeEnabled()
  await expect(page.getByText(/Chrome or Edge on a computer\.$/)).toHaveCount(1)
})

test('T4: where the screen can be recorded, Clips still starts on Screen and camera', async ({
  page,
}) => {
  await page.goto('/clips/new')
  await expect(page.getByTestId('clip-mode-screen_camera').locator('input')).toBeChecked()
  await expect(page.getByTestId('clip-mode-screen').locator('input')).toBeEnabled()
  await expect(page.getByTestId('clip-no-screen')).toHaveCount(0)
})
