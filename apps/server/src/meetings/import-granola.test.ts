import { parseFrontmatter, parseTranscript } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import { blobOidOf } from './enhance/note.js'
import {
  type GranolaMeeting,
  granolaFiles,
  granolaTranscript,
  instantOf,
} from './import-granola.js'

const TZ = 'America/New_York'

const MEETING: GranolaMeeting = {
  ref: 'doc-1',
  title: 'Acme kickoff',
  date: '2026-03-04T15:30:00-05:00',
  notes: 'Dana wants SSO\r\n- pricing by Friday',
  summary: '### Decisions\n- Ship SSO first',
  transcript: 'Me: Hi all\nThem: Hello there.\nand more from them\nMe: Great',
  attendees: ['Dana Lee <dana@acme.com>'],
}

describe('granolaTranscript', () => {
  it('keeps speaker labels, joins unlabelled lines to the one before, maps Me/You/Them', () => {
    expect(granolaTranscript(MEETING.transcript)).toEqual([
      { at: 0, speaker: 'Me', text: 'Hi all' },
      { at: 0, speaker: 'Them', text: 'Hello there. and more from them' },
      { at: 0, speaker: 'Me', text: 'Great' },
    ])
    expect(granolaTranscript('[00:01:05] You: yes\n(1:10) Priya Shah: ok')).toEqual([
      { at: 65, speaker: 'Me', text: 'yes' },
      { at: 70, speaker: 'Priya Shah', text: 'ok' },
    ])
  })

  it('reads plain text as unlabelled lines, and markup in a label as text', () => {
    expect(granolaTranscript('so we said\nthat is: the plan\nok then')).toEqual([
      { at: 0, speaker: 'Speaker', text: 'so we said' },
      { at: 0, speaker: 'Speaker', text: 'that is: the plan' },
      { at: 0, speaker: 'Speaker', text: 'ok then' },
    ])
    expect(granolaTranscript('**Xi**: hi\n**Xi**: yo')[0]?.speaker).toBe('Xi')
    // Prose with colons isn't a list of speakers.
    expect(
      granolaTranscript('the plan is: ship it\nso we said\nwhat we need: more time').map(
        (l) => l.speaker,
      ),
    ).toEqual(['Speaker', 'Speaker', 'Speaker'])
    expect(granolaTranscript('')).toEqual([])
  })
})

describe('instantOf', () => {
  it('honours an offset, and reads a time or date without one in the member’s zone', () => {
    expect(instantOf('2026-03-05T02:00:00.000Z', TZ)?.toISOString()).toBe(
      '2026-03-05T02:00:00.000Z',
    )
    expect(instantOf('2026-03-04T21:00:00', TZ)?.toISOString()).toBe('2026-03-05T02:00:00.000Z')
    expect(instantOf('2026-03-04', TZ)?.toISOString()).toBe('2026-03-04T05:00:00.000Z')
    expect(instantOf('2026-07-04 09:15', TZ)?.toISOString()).toBe('2026-07-04T13:15:00.000Z')
    expect(instantOf('2026-03-04T10:00:00+0530', TZ)?.toISOString()).toBe(
      '2026-03-04T04:30:00.000Z',
    )
    expect(instantOf('March 4, 2026 9:00 PM', TZ)?.toISOString()).toBe('2026-03-05T02:00:00.000Z')
  })

  it('refuses dates that don’t exist', () => {
    expect(instantOf('2026-13-45', TZ)).toBeNull()
    expect(instantOf('2026-02-30T10:00:00Z', TZ)).toBeNull()
    expect(instantOf('someday', TZ)).toBeNull()
  })
})

describe('granolaFiles', () => {
  it('files a UTC time late in the evening on the member’s day', () => {
    const files = granolaFiles({ ...MEETING, date: '2026-03-05T02:00:00Z' }, new Set(), TZ) ?? []
    expect(files[0]?.path).toBe('meetings/2026/03/2026-03-04-acme-kickoff.md')
    expect(parseFrontmatter(files[0]?.content ?? '').data.date).toBe('2026-03-04T21:00:00-05:00')
  })

  it('writes the note, raw notes and transcript on the day it happened', () => {
    const files = granolaFiles(MEETING, new Set(), TZ) ?? []
    expect(files.map((f) => f.path)).toEqual([
      'meetings/2026/03/2026-03-04-acme-kickoff.md',
      expect.stringMatching(/^\.hearth\/meetings\/raw\/[0-9A-Z]{26}\.md$/),
      'meetings/2026/03/2026-03-04-acme-kickoff.transcript.md',
    ])
    const note = parseFrontmatter(files[0]?.content ?? '')
    expect(note.data).toMatchObject({
      type: 'meeting',
      title: 'Acme kickoff',
      date: '2026-03-04T15:30:00-05:00',
      attendees: ['Dana Lee <dana@acme.com>'],
      transcript: '2026-03-04-acme-kickoff.transcript.md',
      imported_from: 'granola',
      import_ref: 'doc-1',
      models: { enhance: 'granola', enhanced_blob: blobOidOf(note.body) },
    })
    expect(note.body).toBe(
      '# Acme kickoff\n\n## My notes\n\nDana wants SSO\n- pricing by Friday\n\n## Summary\n\n### Decisions\n- Ship SSO first\n',
    )
    // The summary (lines 8–11) is AI text; the member's notes are not.
    expect(note.data.ai_ranges).toEqual([[8, 11]])
    expect(note.body.split('\n')[7]).toBe('## Summary')
    expect(files[1]?.content).toBe('Dana wants SSO\n- pricing by Friday\n')
    expect(parseTranscript(files[2]?.content ?? '').map((l) => l.speaker)).toEqual([
      'Me',
      'Them',
      'Me',
    ])
  })

  it('takes the next free name, and skips a meeting with no date or nothing in it', () => {
    const taken = new Set(['meetings/2026/03/2026-03-04-acme-kickoff.md'])
    expect(granolaFiles(MEETING, taken, TZ)?.[0]?.path).toBe(
      'meetings/2026/03/2026-03-04-acme-kickoff-2.md',
    )
    expect(granolaFiles({ ...MEETING, date: 'someday' }, new Set(), TZ)).toBeNull()
    expect(
      granolaFiles({ ...MEETING, notes: ' ', summary: '', transcript: '' }, new Set(), TZ),
    ).toBeNull()
  })

  it('without a summary or transcript, has no AI lines and an empty transcript, ready to enhance', () => {
    const files = granolaFiles({ ...MEETING, summary: '', transcript: '' }, new Set(), TZ) ?? []
    expect(files).toHaveLength(3)
    const note = parseFrontmatter(files[0]?.content ?? '')
    expect(note.data.ai_ranges).toEqual([])
    expect(note.data.models).toEqual({ enhanced_blob: blobOidOf(note.body) })
    expect(note.data.transcript).toBe('2026-03-04-acme-kickoff.transcript.md')
    expect(files[2]?.content).toBe('# Acme kickoff: transcript\n\n')
  })

  it('drops a first summary heading that only repeats the title or says Summary', () => {
    const body = (summary: string) =>
      parseFrontmatter(granolaFiles({ ...MEETING, summary }, new Set(), TZ)?.[0]?.content ?? '')
        .body
    expect(body('# Acme kickoff\n\n- one')).toContain('## Summary\n\n- one\n')
    expect(body('## Summary\n- one')).toContain('## Summary\n\n- one\n')
    expect(body('### Decisions\n- one')).toContain('## Summary\n\n### Decisions')
  })

  it('makes a title one line, and names an untitled meeting', () => {
    const files = granolaFiles({ ...MEETING, title: 'A\nB C' }, new Set(), TZ) ?? []
    expect(parseFrontmatter(files[0]?.content ?? '').data.title).toBe('A B C')
    const untitled = granolaFiles({ ...MEETING, title: '  ' }, new Set(), TZ) ?? []
    expect(untitled[0]?.path).toBe('meetings/2026/03/2026-03-04-granola-meeting.md')
  })
})
