import { docUrl } from './fixtures'
import { expect, type Member, test } from './meetings-fixtures'

// A `tasks` block in a doc is a live list of Hearth Tasks; the file keeps only the query.

test.use({ timezoneId: 'UTC' })

async function quick(member: Member, text: string) {
  const res = await member.request.post('/api/tasks/quick', { data: { text, tz: 'UTC' } })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as { space: string; id: string; title: string }
}

test('a tasks block lists live tasks, ticks them off, and keeps only the query in the file', async ({
  page,
  member,
}) => {
  await quick(member, 'Book the kiln #Studio')
  await quick(member, 'Order clay #Studio')
  await quick(member, 'Call the bank')
  const file = 'docs/studio.md'
  const query = '```tasks\nproject: Studio\nmine: yes\n```'
  const text = `# Studio\n\nThis week:\n\n${query}\n\nAfter the list.\n`
  await member.api.writeFile(member.personal, file, text)
  const saved = (await member.api.readFile(member.personal, file))?.content

  await page.goto(docUrl(member.personal, file))
  const list = page.getByTestId('editor-content').getByTestId('task-query')
  await expect(list.getByTestId('task-query-row')).toHaveCount(2)
  await expect(list).toContainText('Book the kiln')
  await expect(list).not.toContainText('Call the bank')

  // Ticking a task completes it in Tasks and drops it from the open list.
  await list.getByRole('checkbox', { name: 'Complete Order clay' }).check()
  await expect(list.getByTestId('task-query-row')).toHaveCount(1)
  // A task added elsewhere shows up without a reload.
  await quick(member, 'Glaze test tiles #Studio')
  await expect(list).toContainText('Glaze test tiles')
  // The file never changed.
  expect((await member.api.readFile(member.personal, file))?.content).toBe(saved)

  // The reading view shows the same live list.
  await page.getByTestId('reading-toggle').click()
  const reading = page.getByTestId('reading-view').getByTestId('task-query')
  await expect(reading.getByTestId('task-query-row')).toHaveCount(2)

  // Clicking a task opens it in Tasks.
  await reading.getByRole('link', { name: 'Book the kiln' }).click()
  await expect(page).toHaveURL(/\/tasks\/item\//)
})

test('Edit query shows the block’s source, and a bad key says so', async ({ page, member }) => {
  const file = 'docs/query.md'
  await member.api.writeFile(member.personal, file, '# Q\n\n```tasks\ncolour: red\n```\n\nEnd.\n')
  await page.goto(docUrl(member.personal, file))
  const list = page.getByTestId('editor-content').getByTestId('task-query')
  await expect(list).toContainText('“colour” isn’t a task query key')
  await page.getByText('Edit query').click({ force: true })
  await expect(page.getByTestId('editor-content')).toContainText('colour: red')
  await expect(page.getByTestId('task-query')).toHaveCount(0)
})
