import { describe, expect, it } from 'vitest'
import {
  formatTranscriptLine,
  meetingPaths,
  parseTranscript,
  transcriptPathFor,
} from './meetings.js'

describe('meetingPaths', () => {
  it('names the note and transcript by local date and title', () => {
    expect(meetingPaths(new Date(2026, 9, 7, 15, 0), 'Acme sync')).toEqual({
      note: 'meetings/2026/10/2026-10-07-acme-sync.md',
      transcript: 'meetings/2026/10/2026-10-07-acme-sync.transcript.md',
    })
  })

  it('pads the month and day and slugs any title', () => {
    expect(meetingPaths(new Date(2027, 0, 3, 23, 59), 'Réunion: Q1 / budget').note).toBe(
      'meetings/2027/01/2027-01-03-reunion-q1-budget.md',
    )
    expect(meetingPaths(new Date(2027, 0, 3), '').note).toBe(
      'meetings/2027/01/2027-01-03-untitled.md',
    )
  })
})

describe('formatTranscriptLine', () => {
  it('writes [hh:mm:ss] **Speaker:** text', () => {
    expect(
      formatTranscriptLine({ at: 194, speaker: 'Dana Lee', text: "We'd need SSO first." }),
    ).toBe("[00:03:14] **Dana Lee:** We'd need SSO first.")
  })

  it('counts hours past a day and drops fractions of a second', () => {
    expect(formatTranscriptLine({ at: 3725.9, speaker: 'A', text: 'x' })).toBe(
      '[01:02:05] **A:** x',
    )
    expect(formatTranscriptLine({ at: 360000, speaker: 'A', text: 'x' })).toBe(
      '[100:00:00] **A:** x',
    )
  })

  it('keeps each entry on one line', () => {
    expect(formatTranscriptLine({ at: 0, speaker: 'A', text: 'one\n  two\r\nthree' })).toBe(
      '[00:00:00] **A:** one two three',
    )
  })
})

describe('parseTranscript', () => {
  it('round-trips formatted lines', () => {
    const lines = [
      { at: 0, speaker: 'Morgan Holland', text: 'Thanks for joining.' },
      { at: 194, speaker: 'Dana Lee', text: 'We need SSO: before rollout.' },
      { at: 3725, speaker: 'Dr. Sam O’Neil', text: '' },
    ]
    expect(parseTranscript(`${lines.map(formatTranscriptLine).join('\n')}\n`)).toEqual(lines)
  })

  it('skips frontmatter, headings, blank lines, and malformed entries', () => {
    const text = [
      '---',
      'id: 01JA3B7K2N8X4P6Q9R0S5T1UVW',
      '---',
      '# Acme sync transcript',
      '',
      '[00:00:05] **Dana:** Hello.',
      '[0:00:06] **Dana:** one-digit hours',
      '[00:61:00] **Dana:** bad minutes',
      '[00:00:07] Dana: no bold',
      '[00:00:08] **Morgan:** Hi.',
    ].join('\r\n')
    expect(parseTranscript(text)).toEqual([
      { at: 5, speaker: 'Dana', text: 'Hello.' },
      { at: 8, speaker: 'Morgan', text: 'Hi.' },
    ])
  })

  it('returns nothing for an empty transcript', () => {
    expect(parseTranscript('')).toEqual([])
  })
})

describe('transcriptPathFor', () => {
  const note = 'meetings/2026/10/2026-10-07-acme-sync.md'

  it('resolves frontmatter `transcript` beside the note', () => {
    expect(transcriptPathFor(note, { transcript: '2026-10-07-acme-sync.transcript.md' })).toBe(
      'meetings/2026/10/2026-10-07-acme-sync.transcript.md',
    )
    // The note was renamed; its transcript kept its own name.
    expect(
      transcriptPathFor('meetings/2026/10/kickoff.md', {
        transcript: '2026-10-07-acme-sync.transcript.md',
      }),
    ).toBe('meetings/2026/10/2026-10-07-acme-sync.transcript.md')
    expect(transcriptPathFor('top.md', { transcript: 'top.transcript.md' })).toBe(
      'top.transcript.md',
    )
  })

  it('is null without a usable `transcript`, never a guess from the file name', () => {
    expect(transcriptPathFor(note, {})).toBeNull()
    expect(transcriptPathFor(note, { transcript: null })).toBeNull()
    expect(transcriptPathFor(note, { transcript: 42 })).toBeNull()
    expect(transcriptPathFor(note, { transcript: ['a.md'] })).toBeNull()
    expect(transcriptPathFor(note, { transcript: '  ' })).toBeNull()
  })

  it('refuses a path that climbs out of the note’s folder or starts at the root', () => {
    expect(transcriptPathFor(note, { transcript: '../secret.md' })).toBeNull()
    expect(transcriptPathFor(note, { transcript: 'sub/../../x.md' })).toBeNull()
    expect(transcriptPathFor(note, { transcript: '/meetings/x.transcript.md' })).toBeNull()
  })
})
