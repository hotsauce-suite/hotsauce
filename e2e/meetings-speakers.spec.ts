import { createHash } from 'node:crypto'
import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

test('names an unnamed speaker from Claude’s guess, in the transcript and the note', async ({
  page,
  member,
}) => {
  const id = uid()
  const base = `meetings/2026/11/2026-11-12-pilot-call-${id}`
  const body = [`# Pilot call ${id}`, '', '- Speaker 1 wants SSO first', ''].join('\n')
  // As Hearth's Enhance leaves it: the body's git blob id, so the note counts as unedited.
  const bytes = Buffer.from(body, 'utf8')
  const blob = createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex')
  const note = [
    '---',
    'type: meeting',
    `title: Pilot call ${id}`,
    'date: 2026-11-12T10:00:00Z',
    'attendees:',
    '  - Dana Lee <dana@acme.com>',
    '  - Sam Ortiz <sam@acme.com>',
    `transcript: 2026-11-12-pilot-call-${id}.transcript.md`,
    'ai_ranges: [[1, 3]]',
    'speaker_guesses:',
    '  Speaker 1: Dana Lee',
    'models:',
    `  enhanced_blob: ${blob}`,
    '---',
    body,
  ].join('\n')
  const transcript = [
    `# Pilot call ${id} transcript`,
    '',
    '[00:00:01] **Me:** Thanks for joining.',
    '[00:00:04] **Speaker 1:** We need SSO before the pilot.',
    '[00:00:09] **Speaker 2:** Agreed, Okta.',
    '',
  ].join('\n')
  await member.api.writeFile(member.personal, `${base}.transcript.md`, transcript)
  await member.api.writeFile(member.personal, `${base}.md`, note)

  await page.goto(`/meetings/${member.personal}/${base}.md`)
  const panel = page.getByTestId('transcript-panel')
  const who = panel.getByTestId('who-is-who')
  await expect(who).toContainText('Speaker 1 sounds like Dana Lee')
  await who.getByRole('button', { name: 'Confirm' }).click()

  await expect(panel.getByText('Dana Lee', { exact: true })).toBeVisible()
  await expect
    .poll(
      async () => (await member.api.readFile(member.personal, `${base}.transcript.md`))?.content,
    )
    .toContain('**Dana Lee:** We need SSO before the pilot.')
  const saved = (await member.api.readFile(member.personal, `${base}.md`))?.content ?? ''
  expect(saved).toContain('- Dana Lee wants SSO first')
  expect(saved).not.toContain('speaker_guesses')
  await expect(page.getByTestId('editor-content')).toContainText('Dana Lee wants SSO first')

  // Any other label can be named by hand, from the attendees.
  await panel.getByRole('button', { name: 'Speaker 2' }).click()
  await panel.getByRole('button', { name: 'Sam Ortiz' }).click()
  await expect
    .poll(
      async () => (await member.api.readFile(member.personal, `${base}.transcript.md`))?.content,
    )
    .toContain('**Sam Ortiz:** Agreed, Okta.')
  await expect(panel.getByText('Sam Ortiz', { exact: true })).toBeVisible()
  await expect(panel.getByTestId('who-is-who')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/meetings-speakers.png' })
})
