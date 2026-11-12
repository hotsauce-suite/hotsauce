import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Hearth Tasks on a phone (Pixel 7): quick add, completing, and the detail sheet.

test.use({ timezoneId: 'UTC' })

test('on a phone, quick add, the detail sheet and completing all work', async ({
  page,
  member,
}) => {
  const id = uid()
  const title = `Pick up samples ${id}`
  await page.goto('/tasks/today')
  await page.getByTestId('tasks-add').click()
  const input = page.getByTestId('quick-add-input')
  await input.fill(`${title} today p2`)
  await page.getByTestId('quick-add-submit').click()
  const row = page.getByTestId('task-row').filter({ hasText: title })
  await expect(row).toBeVisible()

  // Nothing on the page is wider than the screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  await row.getByTestId('task-open').click()
  const detail = page.getByTestId('task-detail')
  await expect(detail).toBeInViewport()
  await detail.getByTestId('detail-notes').fill('By the loading dock')
  await detail.getByTestId('detail-close').click()
  await expect
    .poll(async () => {
      const res = await member.request.get('/api/tasks', { params: { status: 'all' } })
      const tasks = (await res.json()).tasks as Array<{ title: string; notes: string }>
      return tasks.find((t) => t.title === title)?.notes
    })
    .toBe('By the loading dock')

  await page.getByLabel(`Complete: ${title}`).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('task-undo')).toBeVisible()
})
