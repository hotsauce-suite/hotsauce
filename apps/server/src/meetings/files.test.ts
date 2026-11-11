import { MeetingFrontmatter, parseFrontmatter, parseTranscript } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import {
  attendeeLabel,
  type CaptureInput,
  captureBody,
  captureFiles,
  capturePaths,
  externalDomains,
  transcriptText,
} from './files.js'

const INPUT: CaptureInput = {
  id: '01JA3B7K2N8X4P6Q9R0S5T1UVW',
  title: 'Acme: sync',
  templateId: 'customer-call',
  templateHeadings: ['## Summary', '## Next steps'],
  // 22:30 on the 7th in New York, already the 8th in UTC.
  startedAt: new Date('2026-10-08T02:30:00Z'),
  tz: 'America/New_York',
  audioBytes: 32 * 60_000 * 32, // 32 minutes
  attendees: ['Alice Example <alice@example.test>', 'Dana Lee <dana@acme.com>'],
  companies: ['acme.com'],
  calendarEventId: 'evt1',
  rawNotes: 'Dana wants SSO\r\n- pricing by Fri\r\n',
  segments: [
    { track: 'them', speaker: 'Them', at: 1_500, durationMs: 1000, text: 'Hi there', final: true },
    { track: 'me', speaker: 'Me', at: 0, durationMs: 1000, text: 'Hello', final: true },
    { track: 'me', speaker: 'Me', at: 2_000, durationMs: 500, text: 'partial', final: false },
    { track: 'me', speaker: 'Me', at: 3_725_000, durationMs: 900, text: 'Bye\nnow', final: true },
  ],
}

describe('capturePaths', () => {
  it("dates the files in the owner's time zone, not the server's", () => {
    expect(capturePaths(INPUT)).toEqual({
      note: 'meetings/2026/10/2026-10-07-acme-sync.md',
      transcript: 'meetings/2026/10/2026-10-07-acme-sync.transcript.md',
      raw: '.hearth/meetings/raw/01JA3B7K2N8X4P6Q9R0S5T1UVW.md',
    })
    expect(capturePaths({ ...INPUT, tz: 'Asia/Tokyo' }).note).toBe(
      'meetings/2026/10/2026-10-08-acme-sync.md',
    )
  })

  it('suffixes a second meeting with the same title on the same day', () => {
    expect(capturePaths(INPUT, 2)).toMatchObject({
      note: 'meetings/2026/10/2026-10-07-acme-sync-2.md',
      transcript: 'meetings/2026/10/2026-10-07-acme-sync-2.transcript.md',
    })
  })
})

describe('captureFiles', () => {
  const [note, transcript, raw] = captureFiles(INPUT, capturePaths(INPUT))

  it('writes the note with PRD §7 frontmatter and the raw notes under the first section', () => {
    expect(note?.content).toBe(
      [
        '---',
        'id: 01JA3B7K2N8X4P6Q9R0S5T1UVW',
        'type: meeting',
        'title: "Acme: sync"',
        'date: 2026-10-07T22:30:00-04:00',
        'duration_min: 32',
        'attendees:',
        '  - Alice Example <alice@example.test>',
        '  - Dana Lee <dana@acme.com>',
        'companies:',
        '  - acme.com',
        'template: customer-call',
        'calendar_event_id: evt1',
        'transcript: 2026-10-07-acme-sync.transcript.md',
        'ai_ranges: []',
        'models: {}',
        '---',
        '# Acme: sync',
        '',
        '## Summary',
        '',
        'Dana wants SSO',
        '- pricing by Fri',
        '',
        '## Next steps',
        '',
      ].join('\n'),
    )
    const parsed = MeetingFrontmatter.parse(parseFrontmatter(note?.content ?? '').data)
    expect(parsed).toMatchObject({ title: 'Acme: sync', ai_ranges: [], models: {} })
  })

  it('writes final segments as transcript lines in time order, and the raw notes verbatim', () => {
    expect(transcript?.content).toBe(
      [
        '# Acme: sync: transcript',
        '',
        '[00:00:00] **Me:** Hello',
        '[00:00:01] **Them:** Hi there',
        '[01:02:05] **Me:** Bye now',
        '',
      ].join('\n'),
    )
    expect(parseTranscript(transcript?.content ?? '')).toHaveLength(3)
    expect(raw).toEqual({
      path: '.hearth/meetings/raw/01JA3B7K2N8X4P6Q9R0S5T1UVW.md',
      content: 'Dana wants SSO\r\n- pricing by Fri\r\n',
    })
  })

  it('leaves out calendar_event_id for an ad-hoc meeting', () => {
    const [adHoc] = captureFiles({ ...INPUT, calendarEventId: undefined }, capturePaths(INPUT))
    expect(adHoc?.content).not.toContain('calendar_event_id')
  })
})

describe('captureBody and transcriptText edge cases', () => {
  it('handles no notes and no sections', () => {
    expect(captureBody('T', ['## A', '## B'], '  \n')).toBe('# T\n\n## A\n\n## B\n')
    expect(captureBody('T', [], 'only notes')).toBe('# T\n\nonly notes\n')
    expect(transcriptText('T', [])).toBe('# T: transcript\n\n')
  })
})

describe('attendees and companies', () => {
  it('labels attendees and lists outside domains once', () => {
    expect(attendeeLabel({ email: 'dana@acme.com', name: 'Dana Lee' })).toBe(
      'Dana Lee <dana@acme.com>',
    )
    expect(attendeeLabel({ email: 'x@y.com' })).toBe('x@y.com')
    expect(
      externalDomains(
        ['a@example.test', 'dana@Acme.com', 'b@acme.com', 'c@beta.io'],
        ['example.test'],
      ),
    ).toEqual(['acme.com', 'beta.io'])
  })
})
