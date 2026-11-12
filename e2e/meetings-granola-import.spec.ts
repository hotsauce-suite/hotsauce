import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

test('a Granola CSV export becomes meeting notes, and importing again skips it', async ({
  page,
  member,
}) => {
  const id = uid()
  const csv = [
    'document_id,title,created_at,my_notes,enhanced_notes,transcript,attendees',
    `doc-${id},"Pilot kickoff ${id}",2026-10-02T15:00:00Z,"- ask about SSO","### Decisions\n- Okta first","Me: Shall we start?\nThem: Yes, SSO first.",dana@acme.com`,
  ].join('\n')
  const file = { name: 'granola.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }

  await page.goto('/meetings/import')
  await expect(page.getByTestId('granola-settings-link')).toHaveAttribute(
    'href',
    'https://notes.granola.ai/settings/profile',
  )
  await page.getByTestId('granola-file').setInputFiles(file)
  await expect(page.getByTestId('granola-result')).toContainText('Imported 1 meeting')

  const note = `meetings/2026/10/2026-10-02-pilot-kickoff-${id}.md`
  const saved = (await member.api.readFile(member.personal, note))?.content ?? ''
  expect(saved).toContain('imported_from: granola')
  await page.goto(`/meetings/${member.personal}/${note}`)
  await expect(page.getByTestId('editor-content')).toContainText('ask about SSO')
  await expect(page.getByTestId('editor-content')).toContainText('Okta first')
  await expect(page.getByTestId('transcript-panel')).toContainText('Yes, SSO first.')
  await page.screenshot({ path: 'test-results/meetings-granola-import.png' })

  await page.goto('/meetings/import')
  await page.getByTestId('granola-file').setInputFiles(file)
  await expect(page.getByTestId('granola-result')).toContainText('Imported 0 meetings')
  await expect(page.getByTestId('granola-result')).toContainText('1 meeting skipped')
  await page.screenshot({ path: 'test-results/meetings-granola-import-page.png' })
})
