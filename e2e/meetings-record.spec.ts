import { docText, uid } from './fixtures'
import {
  aiRangesOf,
  bodyLineOf,
  type ChatReply,
  expect,
  meSegment,
  parseMeetingUrl,
  splitNote,
  startMicOnly,
  test,
  transcriptPath,
  typeNotes,
  waitForChat,
} from './meetings-fixtures'

// ARCHITECTURE §7.6 E2E: the capture flow against the built server, with Chromium's fake
// microphone, FakeTranscriber, FakeLLM and FakeCalendar.

test('record from the calendar, stop, enhance twice, chat, and find it in the list', async ({
  page,
  member,
}) => {
  const line = `Ship the pricing one-pager ${uid()}`
  const author = { name: member.name, email: member.email }
  let note = { space: '', path: '' }

  await test.step('home shows the calendar; Take notes opens Start with its title', async () => {
    await page.goto('/meetings')
    await expect(page.getByTestId('meetings-home')).toBeVisible()
    // FakeCalendar's "Acme sync" starts in a minute or two.
    const event = page.getByTestId('calendar-event').filter({ hasText: 'Acme sync' })
    await expect(event).toHaveAttribute('data-event-id', 'fake-acme-sync')
    await event.getByTestId('take-notes').click()
    await page.waitForURL((url) => url.pathname === '/meetings/start')
    await expect(page.getByTestId('start-title')).toHaveValue('Acme sync')
  })

  await test.step('mic only: record, see the transcript, type a note', async () => {
    await startMicOnly(page)
    // The fake device's audio comes back as "me" segments, one per second of audio.
    await expect(meSegment(page, 'me segment 1')).toBeVisible({ timeout: 5_000 })
    await typeNotes(page, line)
    await expect(page.getByTestId('live-notepad')).toContainText(line)
  })

  await test.step('stop opens the note with its transcript and enhances it once', async () => {
    await page.getByTestId('stop').click()
    await page.waitForURL(
      (url) =>
        /^\/meetings\/[^/]+\/meetings\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-acme-sync\.md$/.test(
          url.pathname,
        ),
      { timeout: 10_000 },
    )
    note = parseMeetingUrl(page.url())
    expect(note.space).toBe(member.personal)
    const panel = page.getByTestId('transcript-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('me segment 1')

    // Arriving from Stop enhances without a click; the typed line stays the member's.
    await expect(page.getByTestId('ai-text').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('enhance')).toHaveText(/Re-enhance/)
    await expect(docText(page)).toContainText(line)
    await expect(page.getByTestId('ai-text').filter({ hasText: line })).toHaveCount(0)
  })

  await test.step('Git has the note, transcript and commits, authored by the member', async () => {
    const transcript = await member.api.readFile(note.space, transcriptPath(note.path))
    expect(transcript?.content).toMatch(/^# Acme sync: transcript\n\n\[00:00:00\] \*\*Me:\*\* /)
    expect(transcript?.content).toContain('**Me:** me segment 1\n')
    expect(transcript?.content).not.toContain('**Them:**')

    const file = await member.api.readFile(note.space, note.path)
    if (!file) throw new Error(`${note.path} is not in ${note.space}`)
    const { frontmatter, body } = splitNote(file.content)
    expect(frontmatter).toMatch(/^type: meeting$/m)
    expect(frontmatter).toMatch(/^title: Acme sync$/m)
    expect(frontmatter).toMatch(/^template: general$/m)
    expect(frontmatter).toMatch(/^calendar_event_id: fake-acme-sync$/m)
    expect(frontmatter).toMatch(/^ {2}- Dana Lee <dana@acme\.com>$/m)
    expect(frontmatter).toContain(`\ntranscript: ${transcriptPath(note.path).split('/').at(-1)}\n`)
    expectUserLineKept(frontmatter, body, line)
    expect(body).toMatch(/^# Acme sync\n\n## Summary\n/)

    expect(
      (await member.api.history(note.space, note.path)).map((c) => [c.message, c.author]),
    ).toEqual([
      ['meetings: enhance "Acme sync"', author],
      ['meetings: capture "Acme sync"', author],
    ])
  })

  await test.step('re-enhance with another template keeps the typed line', async () => {
    await page.getByTestId('enhance-template').selectOption('one-on-one')
    const enhanced = page.waitForResponse(
      (r) => r.url().endsWith('/api/meetings/enhance') && r.request().method() === 'POST',
    )
    await page.getByTestId('enhance').click()
    expect((await enhanced).ok()).toBe(true)
    // The page adopts the new note: the 1:1 template's sections, AI lines muted.
    await expect(docText(page)).toContainText('Check-in')
    await expect(page.getByTestId('enhance')).toBeEnabled()
    await expect(page.getByTestId('ai-text').first()).toBeVisible()
    await expect(docText(page)).toContainText(line)
    await expect(page.getByTestId('ai-text').filter({ hasText: line })).toHaveCount(0)

    const file = await member.api.readFile(note.space, note.path)
    const { frontmatter, body } = splitNote(file?.content ?? '')
    expect(frontmatter).toMatch(/^template: one-on-one$/m)
    expect(body).toMatch(/^# Acme sync\n\n## Check-in\n/)
    expectUserLineKept(frontmatter, body, line)
    expect((await member.api.history(note.space, note.path)).map((c) => c.message)).toEqual([
      'meetings: enhance "Acme sync"',
      'meetings: enhance "Acme sync"',
      'meetings: capture "Acme sync"',
    ])
  })

  await test.step('chat about this meeting answers with a citation', async () => {
    const reply = waitForChat(page)
    await page.getByTestId('meeting-chat-input').fill('What did we agree about pricing?')
    await page.getByTestId('meeting-chat-send').click()
    const { citations }: ChatReply = await reply
    const answer = page.getByTestId('chat-answer')
    await expect(answer).toBeVisible()
    await expect(answer.getByTestId('chat-citation')).toHaveCount(citations.length)
    expect(citations.length).toBeGreaterThan(0)
    // Scoped to this meeting: its note or its transcript, at a line that is really there.
    for (const c of citations) {
      expect(c.space).toBe(note.space)
      expect([note.path, transcriptPath(note.path)]).toContain(c.path)
      const cited = (await member.api.readFile(c.space, c.path))?.content.split('\n')[c.line - 1]
      expect(cited?.trim()).toBeTruthy()
      expect(c.text).toContain(cited?.trim())
    }
  })

  await test.step('the meeting is in the list on Meetings home', async () => {
    await page.goto('/meetings')
    const item = page
      .getByTestId('meeting-list')
      .locator(`[data-testid="meeting-item"][data-path="${note.path}"]`)
    await expect(item).toBeVisible()
    await expect(item).toContainText('Acme sync')
  })
})

/** The member's typed line is in the body, verbatim, and outside every AI range. */
function expectUserLineKept(frontmatter: string, body: string, line: string): void {
  const ranges = aiRangesOf(frontmatter)
  expect(ranges.length).toBeGreaterThan(0)
  const at = bodyLineOf(body, line)
  expect(at).toBeGreaterThan(0)
  expect(ranges.filter(([first, last]) => first <= at && at <= last)).toEqual([])
}
