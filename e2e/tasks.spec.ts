import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { uid } from './fixtures'
import { expect, type Member, test } from './meetings-fixtures'

// Hearth Tasks (ARCHITECTURE §12), against the built server with fake transcriber and model.
// Each test gets a fresh member, so their personal tasks and "mine" views never mix.

test.use({ timezoneId: 'UTC' })

interface TaskView {
  space: string
  id: string
  title: string
  notes: string
  status: 'open' | 'done'
  priority: number
  due: string | null
  recur: string | null
  project: string | null
  labels: string[]
  assignee: string | null
  source: { kind: string; path?: string; line?: number } | null
}

function utcDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

async function listTasks(
  request: APIRequestContext,
  params: Record<string, string> = {},
): Promise<TaskView[]> {
  const res = await request.get('/api/tasks', { params: { status: 'all', ...params } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { tasks: TaskView[] }).tasks
}

async function quick(member: Member, text: string, extra: Record<string, unknown> = {}) {
  const res = await member.request.post('/api/tasks/quick', {
    data: { text, tz: 'UTC', ...extra },
  })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as TaskView
}

async function findTask(member: Member, title: string): Promise<TaskView | undefined> {
  return (await listTasks(member.request)).find((t) => t.title === title)
}

function nav(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Task lists' }).getByRole('link', { name })
}

/** Picks `date` (YYYY-MM-DD) in Hotsauce's date picker, moving to its month first. */
async function pickDate(page: Page, button: Locator, date: string) {
  await button.click()
  const picker = page.getByTestId('date-picker')
  const day = picker.locator(`[data-date="${date}"]`)
  // The grid shows a few days of the next month; move on until the day is in the month shown.
  for (let i = 0; i < 2 && !(await day.isVisible()); i++)
    await picker.getByTestId('date-picker-next').click()
  await day.click()
}

function row(page: Page, title: string) {
  return page.getByTestId('task-row').filter({ hasText: title })
}

test('quick add reads the date, time, priority, project and label, and files the task', async ({
  page,
  member,
}) => {
  const id = uid()
  const title = `Call Sam ${id}`
  await page.goto('/tasks/today')
  await expect(page.getByTestId('tasks-page')).toBeVisible()

  await page.keyboard.press('q')
  const input = page.getByTestId('quick-add-input')
  await expect(input).toBeFocused()
  await input.fill(`${title} tomorrow 3pm p1 #Ops${id} @calls`)
  const chips = page.getByTestId('quick-chip')
  // Date and time share one chip: "Tomorrow 3:00 PM".
  await expect(chips).toHaveCount(4)
  await expect(chips.first()).toContainText(/Tomorrow.*3:00/)
  await expect(page.getByTestId('quick-chips')).toContainText(`Ops${id}`)
  await input.press('Enter')

  await expect
    .poll(() => findTask(member, title))
    .toMatchObject({
      title,
      due: `${utcDate(1)}T15:00`,
      priority: 1,
      project: `Ops${id}`,
      labels: ['calls'],
      status: 'open',
    })

  // Due tomorrow: not in Today, in Upcoming under its day, and in its project.
  await expect(row(page, title)).toHaveCount(0)
  await nav(page, 'Upcoming').click()
  await expect(row(page, title)).toBeVisible()
  await expect(row(page, title).getByTestId('task-due')).toContainText(/Tomorrow/)
  await page
    .getByTestId('tasks-nav-project')
    .filter({ hasText: `Ops${id}` })
    .click()
  await expect(page.getByTestId('tasks-title')).toHaveText(`#Ops${id}`)
  await expect(row(page, title)).toBeVisible()
})

test('completing a task can be undone, and done tasks are listed under Done', async ({
  page,
  member,
}) => {
  const id = uid()
  const title = `Pay the invoice ${id}`
  await quick(member, `${title} today`)
  await page.goto('/tasks/today')
  await expect(row(page, title)).toBeVisible()

  await page.getByLabel(`Complete: ${title}`).click()
  await expect(page.getByTestId('task-toast')).toBeVisible()
  await expect(row(page, title)).toHaveCount(0)
  await expect.poll(async () => (await findTask(member, title))?.status).toBe('done')

  await page.getByTestId('task-undo').click()
  await expect(row(page, title)).toBeVisible()
  await expect.poll(async () => (await findTask(member, title))?.status).toBe('open')

  await page.getByLabel(`Complete: ${title}`).click()
  await expect.poll(async () => (await findTask(member, title))?.status).toBe('done')
  await nav(page, 'Done').click()
  await expect(row(page, title)).toBeVisible()

  // The commits are the member's, with the app's messages.
  const task = await findTask(member, title)
  const history = await member.api.history(task?.space ?? '', `tasks/${task?.id}.md`)
  expect(history.map((c) => c.message)).toEqual([
    `tasks: complete "${title}"`,
    `tasks: reopen "${title}"`,
    `tasks: complete "${title}"`,
    `tasks: create "${title}"`,
  ])
  expect(history.every((c) => c.author.email === member.email)).toBe(true)
})

test('a recurring task moves to its next date when completed', async ({ page, member }) => {
  const id = uid()
  const title = `Water the plants ${id}`
  await quick(member, `${title} every day`)
  await page.goto('/tasks/today')
  await page.getByLabel(`Complete: ${title}`).click()
  await expect(row(page, title)).toHaveCount(0)
  await expect.poll(async () => (await findTask(member, title))?.due).toBe(utcDate(1))
  expect((await findTask(member, title))?.status).toBe('open')
  await nav(page, 'Upcoming').click()
  await expect(row(page, title)).toBeVisible()
})

test('edits in the detail panel are saved and survive a reload', async ({ page, member }) => {
  const id = uid()
  const title = `Draft the board memo ${id}`
  const task = await quick(member, title)
  await page.goto('/tasks')
  await row(page, title).getByTestId('task-open').click()
  const detail = page.getByTestId('task-detail')
  await expect(detail.getByTestId('detail-title')).toHaveValue(title)

  await detail.getByTestId('detail-notes').fill(`Numbers from finance ${id}`)
  await detail.getByTestId('detail-title').click()
  await detail.getByTestId('detail-priority-2').click()
  await pickDate(page, detail.getByTestId('detail-date'), utcDate(3))
  await expect
    .poll(async () => findTask(member, title))
    .toMatchObject({ notes: `Numbers from finance ${id}`, priority: 2, due: utcDate(3) })

  await page.goto(`/tasks/item/${task.space}/${task.id}`)
  const reopened = page.getByTestId('task-detail')
  await expect(reopened.getByTestId('detail-notes')).toHaveValue(`Numbers from finance ${id}`)
  await expect(reopened.getByTestId('detail-date')).toHaveAttribute('data-value', utcDate(3))
})

test('team tasks are visible to teammates; personal ones are not', async ({
  member,
  newMember,
}) => {
  const id = uid()
  const other = await newMember()
  const shared = await quick(member, `Book the offsite ${id}`, { space: member.team })
  const mine = await quick(member, `Personal errand ${id}`)
  expect(mine.space).toBe(member.personal)

  const seen = await listTasks(other.request, { mine: 'false' })
  expect(seen.map((t) => t.title)).toContain(`Book the offsite ${id}`)
  expect(seen.map((t) => t.title)).not.toContain(`Personal errand ${id}`)
  expect((await other.request.get(`/api/tasks/${mine.space}/${mine.id}`)).status()).toBe(403)

  // Assigning a teammate puts the task in the team space and in their "mine" list.
  const assigned = await quick(member, `Review contract ${id} +${other.email}`, {
    space: member.team,
  })
  expect(assigned.assignee).toBe(other.email)
  const theirs = await listTasks(other.request, { mine: 'true', status: 'open' })
  expect(theirs.map((t) => t.title)).toContain(`Review contract ${id}`)
  expect(shared.space).toBe(member.team)
})

test('a meeting action item becomes a task, and completing it ticks the note', async ({
  page,
  member,
}) => {
  const id = uid()
  const item = `Send the pilot scope ${id}`
  const path = `meetings/2026/11/2026-11-10-pilot-${id}.md`
  await member.api.writeFile(
    member.personal,
    path,
    `---\ntype: meeting\ntitle: Pilot ${id}\ndate: ${new Date().toISOString()}\nattendees: []\n---\n# Pilot ${id}\n\n## Action items\n\n- [ ] ${item}\n`,
  )
  await page.goto('/tasks/today')
  const meetingItem = page.getByTestId('meeting-item').filter({ hasText: item })
  await expect(meetingItem).toBeVisible()
  await meetingItem.getByTestId('meeting-item-add').click()
  await expect(row(page, item)).toBeVisible()
  await expect(meetingItem).toHaveCount(0)
  await expect
    .poll(async () => (await findTask(member, item))?.source)
    .toMatchObject({ kind: 'meeting', path })

  await page.getByLabel(`Complete: ${item}`).click()
  await expect
    .poll(async () => (await member.api.readFile(member.personal, path))?.content)
    .toContain(`- [x] ${item}`)
})

test('Ramble turns a recording into tasks to review and add', async ({ page, member }) => {
  await page.goto('/tasks')
  await page.getByTestId('quick-add-open').click()
  await page.getByTestId('ramble-open').click()
  await expect(page.getByTestId('ramble-timer')).toBeVisible()
  // The level meter says the microphone hears something (Chromium's fake mic beeps).
  await expect(page.getByTestId('ramble-heard')).toHaveAttribute('data-state', 'heard')
  // Chromium's fake microphone plays a tone; let a couple of seconds record.
  await page.waitForTimeout(2_500)
  await page.getByTestId('ramble-stop').click()
  const lines = page.getByTestId('ramble-line')
  await expect(page.getByTestId('ramble-review')).toBeVisible({ timeout: 15_000 })
  await expect(lines.first()).toBeVisible()
  const count = await lines.count()
  await page.getByTestId('ramble-add').click()
  await expect
    .poll(async () => (await listTasks(member.request)).filter((t) => t.source?.kind === 'voice'))
    .toHaveLength(count)
})

test('a Todoist CSV export imports into the personal space, once', async ({ page, member }) => {
  const id = uid()
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE',
    `task,Renew the lab lease ${id},Ask about parking,1,1,,,tomorrow,en,UTC`,
    `task,Order reagents ${id},,4,1,,,every monday,en,UTC`,
  ].join('\n')
  await page.goto('/tasks/import')
  await page.getByTestId('todoist-files').setInputFiles({
    name: `Lab ${id}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  })
  await expect(page.getByTestId('todoist-result')).toContainText('2')
  await expect
    .poll(() => findTask(member, `Renew the lab lease ${id}`))
    .toMatchObject({
      priority: 1,
      notes: 'Ask about parking',
      due: utcDate(1),
      project: `Lab ${id}`,
      source: { kind: 'import' },
    })
  expect((await findTask(member, `Order reagents ${id}`))?.recur).toBe('every monday')

  // A second import of the same file adds nothing.
  await page.goto('/tasks/import')
  await page.getByTestId('todoist-files').setInputFiles({
    name: `Lab ${id}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  })
  await expect(page.getByTestId('todoist-result')).toBeVisible()
  const all = await listTasks(member.request)
  expect(all.filter((t) => t.title.endsWith(id))).toHaveLength(2)
})

test('All tasks lists every open task, including a teammate’s in Team', async ({
  page,
  member,
  newMember,
}) => {
  const id = uid()
  const other = await newMember()
  await quick(member, `Personal thing ${id}`)
  await quick(member, `Project thing ${id} #Lab${id}`)
  await quick(member, `For a teammate ${id} +${other.email}`, { space: member.team })
  await page.goto('/tasks')
  // The teammate's task is in none of the member's own lists...
  await expect(row(page, `For a teammate ${id}`)).toHaveCount(0)
  await nav(page, 'All tasks').click()
  await expect(page.getByTestId('tasks-title')).toHaveText('All tasks')
  // ...but All tasks shows all three.
  for (const title of [`Personal thing ${id}`, `Project thing ${id}`, `For a teammate ${id}`]) {
    await expect(row(page, title)).toBeVisible()
  }
  await expect(page.getByText('Rest of the team')).toBeVisible()
})
