import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

function meetingNote(title: string, date: string, body: string): string {
  return `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees: []\n---\n# ${title}\n\n${body}\n`
}

test('open action items show on Meetings home, tick off with a commit, and link to their line', async ({
  page,
  member,
}) => {
  const id = uid()
  const path = `meetings/2026/11/2026-11-06-pilot-review-${id}.md`
  const task = `Send the pilot scope ${id}`
  const other = `Book the lab visit ${id}`
  await member.api.writeFile(
    member.personal,
    path,
    meetingNote(
      `Pilot review ${id}`,
      '2026-11-06T10:00:00Z',
      `## Action items\n\n- [ ] ${task}\n- [ ] ${other}\n- [x] Already done`,
    ),
  )

  // The server adds an `id` to the frontmatter, so read the line from what it stored.
  const stored = (await member.api.readFile(member.personal, path))?.content ?? ''
  const line = stored.split('\n').indexOf(`- [ ] ${task}`) + 1
  expect(line).toBeGreaterThan(0)

  await page.goto('/meetings')
  const section = page.getByTestId('action-items')
  await expect(section.getByTestId('action-item')).toHaveText([new RegExp(task), new RegExp(other)])
  // The meeting link opens the note at the item's line.
  await expect(section.getByRole('link', { name: `Pilot review ${id}` }).first()).toHaveAttribute(
    'href',
    new RegExp(`${path.replaceAll('/', '\\/')}#L${line}$`),
  )

  await page.getByLabel(`Mark done: ${task}`).click()
  await expect(section.getByTestId('action-item')).toHaveCount(1)
  await expect
    .poll(async () => (await member.api.readFile(member.personal, path))?.content)
    .toContain(`- [x] ${task}`)
  expect((await member.api.history(member.personal, path))[0]?.message).toBe(
    `meetings: complete "${task}"`,
  )

  // After a reload it stays done.
  await page.reload()
  await expect(page.getByTestId('action-item')).toHaveText([new RegExp(other)])
})

test('Cmd-K opens a meeting note on its meeting page, with its transcript panel', async ({
  page,
  member,
}) => {
  const id = uid()
  const word = `osprey${id}`
  const path = `meetings/2026/11/2026-11-07-vendor-call-${id}.md`
  await member.api.writeFile(
    member.personal,
    path,
    meetingNote(`Vendor call ${id}`, '2026-11-07T10:00:00Z', `## Summary\n\nThe ${word} quote.`),
  )

  await page.goto('/meetings')
  await expect(page.getByTestId('meetings-home')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+K')
  const result = page.getByTestId('search-result').filter({ hasText: `Vendor call ${id}` })
  await expect(async () => {
    await page.getByTestId('cmdk-input').fill(word)
    await expect(result.first()).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 5_000 })
  await expect(result.first()).toContainText('Meeting ·')
  await result.first().click()
  await expect(page).toHaveURL(new RegExp(`/meetings/${member.personal}/${path}$`))
})
