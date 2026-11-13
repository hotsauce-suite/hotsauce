import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Today, the home page (ARCHITECTURE §16, plan T7): sign in, land on Today, see the calendar's
// meeting and a task due today, and complete it there.

test.use({ timezoneId: 'UTC' })

test('T7: sign in lands on Today; the meeting and a due task show; completing it works', async ({
  page,
  member,
}) => {
  const title = `Send the deck ${uid()}`
  const made = await member.request.post('/api/tasks/quick', {
    data: { text: `${title} today`, tz: 'UTC' },
  })
  expect(made.status(), await made.text()).toBe(201)
  const task = (await made.json()) as { space: string; id: string }

  await page.goto('/')
  await expect(page).toHaveURL(/\/today$/)
  await expect(page.getByTestId('app-switch-today')).toHaveAttribute('aria-current', 'page')

  // The fake calendar's next meeting, with Take notes.
  const meeting = page.getByTestId('today-meeting').filter({ hasText: 'Acme sync' })
  await expect(meeting).toBeVisible()
  await expect(meeting.getByTestId('today-take-notes')).toHaveAttribute(
    'href',
    '/meetings/start?event=fake-acme-sync',
  )

  const tasks = page.getByTestId('today-tasks')
  const row = tasks.getByTestId('today-task').filter({ hasText: title })
  await expect(row).toBeVisible()
  await row.getByTestId('today-task-done').click()
  await expect(row).toHaveCount(0)
  await expect
    .poll(async () => {
      const res = await member.request.get(`/api/tasks/${task.space}/${task.id}`)
      return ((await res.json()) as { status: string }).status
    })
    .toBe('done')

  // Added on Today means due today, so it stays on the page.
  const later = `Water the plants ${uid()}`
  await page.getByTestId('today-quick-add').fill(later)
  await page.getByTestId('today-quick-add').press('Enter')
  await expect(tasks.getByTestId('today-task').filter({ hasText: later })).toBeVisible()
})

test('J1: the clock shows; a tile added in Edit Today stays after a reload', async ({
  page,
  member,
}) => {
  // Start from the default layout, whatever an earlier run saved.
  const reset = await member.request.put('/api/today/layout', {
    data: {
      layout: {
        schema: 1,
        columns: [
          [
            { id: 'meetings', kind: 'meetings' },
            { id: 'tasks', kind: 'tasks' },
          ],
          [{ id: 'docs', kind: 'docs' }],
        ],
      },
    },
  })
  expect(reset.status(), await reset.text()).toBe(200)

  await page.goto('/today')
  await expect(page.getByTestId('today-time')).toHaveText(/\d{1,2}:\d{2}/)
  await expect(page.getByTestId('today-greeting')).toHaveText(/^Good /)

  await page.getByTestId('today-edit').click()
  await page.getByTestId('today-add-tile').click()
  await page.getByTestId('today-add-starred').click()
  const starred = page
    .getByTestId('today-edit-tile')
    .filter({ has: page.getByTestId('today-starred') })
  await expect(starred).toBeVisible()
  // Added to the shorter (right) column, under Docs changed; move it up above it.
  await starred.getByTestId('today-tile-up').click()
  await page.getByTestId('today-done').click()
  await expect(page.getByTestId('today-edit-bar')).toHaveCount(0)

  await page.reload()
  const right = page.getByTestId('today-column-1')
  await expect(right.getByTestId('today-starred')).toBeVisible()
  const order = await right
    .locator('section[data-testid]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order.slice(0, 2)).toEqual(['today-starred', 'today-docs'])
})
