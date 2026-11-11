import { uid } from './fixtures'
import { type ChatReply, expect, test, waitForChat } from './meetings-fixtures'

function meetingNote(title: string, date: string, body: string): string {
  return `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees: []\n---\n# ${title}\n\n${body}\n`
}

test('Ask across meetings cites the right meeting and opens it at the cited line', async ({
  page,
  member,
}) => {
  const id = uid()
  const word = `kestrel${id}`
  const cited = `meetings/2026/09/2026-09-14-supplier-review-${id}.md`
  const other = `meetings/2026/09/2026-09-15-garden-rota-${id}.md`
  const line = `The ${word} contract renews in March.`
  // Long enough that the cited section starts well below the first screen.
  const earlier = Array.from({ length: 60 }, (_, i) => `- Budget line ${i + 1}.`).join('\n')
  await member.api.writeFile(
    member.personal,
    cited,
    meetingNote(
      'Supplier review',
      '2026-09-14T10:00:00Z',
      `## Earlier\n\n${earlier}\n\n## Renewal\n\n${line}`,
    ),
  )
  await member.api.writeFile(
    member.personal,
    other,
    meetingNote('Garden rota', '2026-09-15T10:00:00Z', '## Summary\n\nWatering starts on Monday.'),
  )
  const question = `When does the ${word} contract renew?`

  // The index takes the commits just after they land; ask once it has them.
  await expect
    .poll(async () => {
      const res = await member.request.post('/api/meetings/chat', {
        data: { question, scope: {} },
      })
      return ((await res.json()) as ChatReply).citations[0]?.path
    })
    .toBe(cited)

  await page.goto('/meetings/ask')
  const reply = waitForChat(page)
  await page.getByTestId('meeting-chat-input').fill(question)
  await page.getByTestId('meeting-chat-send').click()
  const { citations } = await reply
  const first = citations[0]
  if (!first) throw new Error('the answer cited nothing')
  expect(first).toMatchObject({ space: member.personal, path: cited })
  // The cited line is really there.
  const content = (await member.api.readFile(member.personal, cited))?.content ?? ''
  expect(content.split('\n')[first.line - 1]).toBeTruthy()
  expect(first.text).toContain(content.split('\n')[first.line - 1])

  const answer = page.getByTestId('chat-answer')
  await expect(answer).toContainText('Here is what your meetings say')
  const citation = answer.getByTestId('chat-citation').first()
  await expect(citation).toContainText(`line ${first.line}`)
  await citation.click()

  await page.waitForURL(
    (url) =>
      url.pathname === `/meetings/${encodeURIComponent(member.personal)}/${cited}` &&
      url.hash === `#L${first.line}`,
  )
  // The editor scrolled the cited line into view.
  await expect(page.getByTestId('editor-content').getByText(line)).toBeInViewport()
})
