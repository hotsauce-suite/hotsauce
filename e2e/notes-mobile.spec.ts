import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Hearth Notes on a phone (Pixel 7): two columns, the composer, and the editor as a bottom sheet.

test('on a phone, taking a note and editing it in the sheet both work', async ({
  page,
  member,
}) => {
  expect(member.email).toBeTruthy()
  const id = uid()
  await page.goto('/notes')
  await page.getByTestId('notes-take-note').click()
  await page.getByTestId('composer-title').fill(`Phone note ${id}`)
  await page.getByTestId('composer-body').fill('Typed on a phone')
  await page.getByTestId('composer-close').click()
  const card = page.getByTestId('note-card').filter({ hasText: `Phone note ${id}` })
  await expect(card).toBeVisible()

  // Nothing on the page is wider than the screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  await card.getByTestId('note-card-open').click()
  const editor = page.getByTestId('note-editor')
  await expect(editor).toBeInViewport()
  // The sheet sits on the bottom edge.
  const box = await editor.boundingBox()
  const height = page.viewportSize()?.height ?? 0
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual(height - 2)
  await editor.getByTestId('note-editor-body').fill('Edited on a phone')
  await editor.getByTestId('note-editor-close').click()
  await expect(card).toContainText('Edited on a phone')
})
