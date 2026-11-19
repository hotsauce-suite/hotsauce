import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Sharing a screenshot the way the Mac app does (docs/PLAN-screenshots.md R4, R5): the app calls
// a function on the signed-in page, which uploads the picture and answers with its link.

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAWwCAJw9AgM4cQdZAAAAAElFTkSuQmCC'

test('a screenshot shared from the Mac app lands in Files, deletes itself, and can be kept', async ({
  page,
  member,
}) => {
  const name = `Screenshot ${uid()}.png`
  await page.goto('/files')
  await expect(page.getByTestId('app-switch-files')).toHaveAttribute('aria-current', 'page')

  const result = await page.evaluate(
    ([n, png]) =>
      (
        window as unknown as {
          hotsauceMac: { shareScreenshot(n: string, p: string): Promise<Record<string, unknown>> }
        }
      ).hotsauceMac.shareScreenshot(n as string, png as string),
    [name, PNG],
  )
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(String(result.url)).toMatch(/^http.+\/(s|files\/s)\/[A-Za-z0-9_-]{16,}$/)
  const days = (Date.parse(String(result.deleteAfter)) - Date.now()) / 86_400_000
  expect(days).toBeGreaterThan(29.9)
  expect(days).toBeLessThan(30.1)

  // The link opens the picture.
  await page.goto(String(result.url))
  await expect(page.getByTestId('file-preview-image')).toBeVisible()

  // It sits in the member's Screenshots folder, saying when it goes.
  await page.goto(`/files?space=${encodeURIComponent(member.personal)}&folder=Screenshots`)
  const row = page.getByTestId('files-row').filter({ hasText: name })
  await expect(row).toContainText('Deletes')
  await row.getByTestId('files-open').click()
  await expect(page.getByTestId('file-deletes-note')).toContainText('Deletes itself on')

  // Keep stops it.
  await page.getByTestId('file-keep').click()
  await expect(page.getByTestId('file-deletes-note')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(row).not.toContainText('Deletes')
})
