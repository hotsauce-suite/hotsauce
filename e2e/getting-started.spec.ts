import { expect, test } from './meetings-fixtures'

// A new member's first run (docs/PLAN-getting-started.md, J1): Getting started is the first thing
// on Today, Hide removes it for good, and Settings brings it back.

test('J1: Getting started leads Today, hides for good, and comes back from Settings', async ({
  page,
  member,
}) => {
  // As a member who hasn't dealt with it yet, whatever an earlier run saved.
  const reset = await member.request.put('/api/today/layout', {
    data: {
      layout: {
        schema: 1,
        columns: [
          [
            { id: 'start', kind: 'start' },
            { id: 'meetings', kind: 'meetings' },
            { id: 'tasks', kind: 'tasks' },
          ],
          [{ id: 'docs', kind: 'docs' }],
        ],
      },
    },
  })
  expect(reset.status(), await reset.text()).toBe(200)

  await page.goto('/')
  const tile = page.getByTestId('today-start')
  await expect(tile).toBeVisible()
  // First on the page, above the day's tiles.
  await expect(page.getByTestId('today-column-0').locator('section').first()).toHaveAttribute(
    'data-testid',
    'today-start',
  )
  // The fake calendar is connected, so that step arrives ticked; Docs hasn't been opened.
  await expect(tile.locator('[data-step="calendar"]')).toHaveAttribute('data-done', 'true')
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'false')

  await page.getByTestId('today-start-hide').click()
  await expect(tile).toHaveCount(0)
  await expect
    .poll(async () => {
      const res = await member.request.get('/api/today/layout')
      const body = (await res.json()) as { layout: { gettingStarted?: string } }
      return body.layout.gettingStarted
    })
    .toBe('dismissed')
  await page.reload()
  await expect(page.getByTestId('today-tasks')).toBeVisible()
  await expect(tile).toHaveCount(0)

  // Settings → Getting started puts it back at the top.
  await page.goto('/settings')
  await page.getByTestId('settings-getting-started').click()
  await expect(page).toHaveURL(/\/today$/)
  await expect(tile).toBeVisible()
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'false')

  // Open Docs ticks the last open step that only a click can show.
  await page.getByTestId('today-start-docs').click()
  await expect(page).toHaveURL(/\/docs/)
  await page.goto('/today')
  await expect(tile.locator('[data-step="docs"]')).toHaveAttribute('data-done', 'true')

  // Leave Today as other specs expect it.
  await page.getByTestId('today-start-hide').click()
  await expect(tile).toHaveCount(0)
})
