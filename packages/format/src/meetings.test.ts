import { describe, expect, it } from 'vitest'
import {
  cleanSpeakerName,
  dropEchoes,
  fixTranscriptWords,
  formatTranscriptLine,
  meetingPaths,
  parseTranscript,
  renameSpeakers,
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
      { at: 0, speaker: 'Ada Lovelace', text: 'Thanks for joining.' },
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
      '[00:00:08] **Ada:** Hi.',
    ].join('\r\n')
    expect(parseTranscript(text)).toEqual([
      { at: 5, speaker: 'Dana', text: 'Hello.' },
      { at: 8, speaker: 'Ada', text: 'Hi.' },
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

describe('dropEchoes', () => {
  const seg = (track: 'me' | 'them', at: number, text: string) => ({ track, at, text })

  it('drops the other side heard again on the mic, close in time', () => {
    const them = seg('them', 10_000, 'We should ship the pricing page on Friday.')
    const echo = seg('me', 10_600, 'we should ship the pricing page Friday')
    const mine = seg('me', 14_000, 'Friday works, I will draft it tonight.')
    expect(dropEchoes([them, echo, mine])).toEqual([them, mine])
  })

  it('keeps a reply that shares a few words, short lines, and lines far apart in time', () => {
    const them = seg('them', 10_000, 'Can you send the deck to Acme today?')
    const reply = seg('me', 12_000, 'Yes, I will send Acme the deck after lunch.')
    const short = seg('me', 10_500, 'send the deck')
    const later = seg('me', 30_000, 'Can you send the deck to Acme today?')
    expect(dropEchoes([them, reply, short, later])).toEqual([them, reply, short, later])
  })

  it('without a them track nothing changes', () => {
    const only = [seg('me', 0, 'one two three four five')]
    expect(dropEchoes(only)).toBe(only)
  })
})

describe('renameSpeakers', () => {
  const text = [
    '# Acme sync transcript',
    '',
    '[00:00:01] **Me:** Hi Speaker 1.',
    '[00:00:04] **Speaker 1:** Hi, Priya here.',
    '[00:00:09] **Speaker 12:** And me.',
    'not a line **Speaker 1:**',
  ].join('\r\n')

  it('renames only the labels it is given, keeping every other byte', () => {
    const out = renameSpeakers(text, { 'Speaker 1': 'Priya Shah' })
    expect(out.split('\r\n')).toEqual([
      '# Acme sync transcript',
      '',
      '[00:00:01] **Me:** Hi Speaker 1.',
      '[00:00:04] **Priya Shah:** Hi, Priya here.',
      '[00:00:09] **Speaker 12:** And me.',
      'not a line **Speaker 1:**',
    ])
    expect(parseTranscript(out).map((l) => l.speaker)).toEqual(['Me', 'Priya Shah', 'Speaker 12'])
  })

  it('leaves the text alone with no names', () => {
    expect(renameSpeakers(text, {})).toBe(text)
  })
})

describe('cleanSpeakerName', () => {
  it('keeps a plain name and refuses what would break a transcript line', () => {
    expect(cleanSpeakerName('  Priya   Shah ')).toBe('Priya Shah')
    expect(cleanSpeakerName('**Evil:** x')).toBe('Evil x')
    expect(cleanSpeakerName('Me')).toBeNull()
    expect(cleanSpeakerName('   ')).toBeNull()
    expect(cleanSpeakerName('x'.repeat(61))).toBeNull()
  })
})

describe('speaker names from outside', () => {
  it('strips markup a calendar display name could carry', () => {
    expect(cleanSpeakerName('![](//evil.example/p.png)')).toBe('evil.example p.png')
    expect(cleanSpeakerName('<img src=//x>')).toBe('img src x')
    expect(cleanSpeakerName('José O’Neil-Smith')).toBe('José O’Neil-Smith')
  })

  it('treats prototype names as ordinary labels', () => {
    const text = '[00:00:01] **constructor:** hi\n[00:00:02] **Speaker 1:** yo'
    expect(renameSpeakers(text, { 'Speaker 1': 'Sam' })).toBe(
      '[00:00:01] **constructor:** hi\n[00:00:02] **Sam:** yo',
    )
  })
})

describe('fixTranscriptWords', () => {
  const text = [
    '# Sync: transcript',
    '',
    '[00:00:01] **Me:** We met the acme bio lab team.',
    '[00:00:04] **Speaker 1:** Acme is great; acmely is not acme.\r',
    '[00:00:09] **Them:** Talk to pria tomorrow.',
    '',
  ].join('\n')

  it('fixes whole words on the numbered line only, keeping every other byte', () => {
    const out = fixTranscriptWords(text, [
      { line: 0, from: 'acme bio lab', to: 'AcmeBioLab' },
      { line: 1, from: 'acme', to: 'Acme' },
      { line: 2, from: 'pria', to: 'Priya' },
    ])
    expect(out).toBe(
      [
        '# Sync: transcript',
        '',
        '[00:00:01] **Me:** We met the AcmeBioLab team.',
        '[00:00:04] **Speaker 1:** Acme is great; acmely is not Acme.\r',
        '[00:00:09] **Them:** Talk to Priya tomorrow.',
        '',
      ].join('\n'),
    )
  })

  it('never touches labels or timestamps, and ignores fixes that do not match', () => {
    expect(fixTranscriptWords(text, [{ line: 2, from: 'Them', to: 'Dana' }])).toBe(text)
    expect(fixTranscriptWords(text, [{ line: 9, from: 'pria', to: 'Priya' }])).toBe(text)
    expect(fixTranscriptWords(text, [{ line: 0, from: 'a', to: 'b' }])).toBe(text)
  })

  it('treats special characters in a phrase literally', () => {
    const t = '[00:00:01] **Me:** c++ and $5 (maybe)\n'
    expect(fixTranscriptWords(t, [{ line: 0, from: '(maybe)', to: '(perhaps)' }])).toBe(
      '[00:00:01] **Me:** c++ and $5 (perhaps)\n',
    )
  })
})

describe('fixTranscriptWords and line breaks', () => {
  it('refuses a fix that would forge a new line', () => {
    const t = '[00:00:01] **Them:** pay pria now\n'
    for (const to of ['Priya\n[00:12:00] **Me:** I approve', 'Priya\r', 'Priya\u2028x']) {
      expect(fixTranscriptWords(t, [{ line: 0, from: 'pria', to }])).toBe(t)
    }
  })
})
