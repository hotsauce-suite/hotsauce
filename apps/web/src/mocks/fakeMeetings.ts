// An in-memory stand-in for the server's Meetings module (ARCHITECTURE §7.1): sessions, a
// deterministic transcriber (one segment per second of audio per track, a partial at the half
// second), a fake calendar, enhancement and chat that behave like their contracts.

import {
  formatTranscriptLine,
  meetingPaths,
  newId,
  parseFrontmatter,
  parseTranscript,
  patchFrontmatter,
} from '@hearth/format'
import type {
  Author,
  CalendarChoice,
  CalendarEvent,
  CalendarMatch,
  CalendarStatus,
  ChatAnswer,
  ChatCitation,
  ChatScope,
  CoverageItem,
  CreateSessionBody,
  EnhanceResult,
  MeetingFilters,
  MeetingSession,
  MeetingSummary,
  MeetingTemplate,
  StopResult,
  Track,
  TranscriptSegment,
} from '../api/types'
import { meetCallCode } from '../apps/meetings/meetEvent'
import { blobOid, type FakeRepo, type FakeUser } from './fakeRepo'

/** One second of 16 kHz mono PCM16, per ARCHITECTURE §7.1's FakeTranscriber. */
export const BYTES_PER_SEGMENT = 32_000

const HOME_DOMAIN = 'example.test'
const SPEAKER: Record<Track, string> = { me: 'Me', them: 'Them' }

export interface FakeTemplate extends MeetingTemplate {
  sections: string[]
}

export const TEMPLATES: FakeTemplate[] = [
  {
    id: 'general',
    name: 'General',
    description: 'Summary, discussion, decisions and action items.',
    source: 'builtin',
    sections: ['Summary', 'Discussion', 'Decisions', 'Action items'],
  },
  {
    id: 'one-on-one',
    name: '1:1',
    description: 'Check-in, topics, feedback, and what each of you will do.',
    source: 'builtin',
    sections: ['Check-in', 'Topics', 'Feedback', 'Action items'],
  },
  {
    id: 'customer-call',
    name: 'Customer call',
    description: 'Their situation, needs and objections, and next steps.',
    source: 'builtin',
    sections: ['Summary', 'Their situation', 'Needs and objections', 'Next steps', 'Action items'],
  },
  {
    id: 'candidate-interview',
    name: 'Candidate interview',
    description: 'Background, strengths, concerns and a recommendation.',
    source: 'builtin',
    sections: ['Summary', 'Background', 'Strengths', 'Concerns', 'Recommendation'],
  },
  {
    id: 'standup',
    name: 'Standup',
    description: 'Yesterday, today, blockers.',
    source: 'builtin',
    sections: ['Yesterday', 'Today', 'Blockers', 'Action items'],
  },
  {
    id: 'pitch',
    name: 'Pitch',
    description: 'Their questions and concerns, and what happens next.',
    source: 'builtin',
    sections: ['Summary', 'Their questions', 'Concerns', 'Next steps', 'Action items'],
  },
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    description: 'The goal, every idea, the favorites.',
    source: 'builtin',
    sections: ['Goal', 'Ideas', 'Favorites', 'Action items'],
  },
]

const templateById = (id: string | undefined) =>
  TEMPLATES.find((t) => t.id === id) ?? (TEMPLATES[0] as FakeTemplate)

export interface FakeSession extends MeetingSession {
  /** Bytes received per track; the next `ready` reports these as `resumeFrom`. */
  received: Record<Track, number>
  /** The bytes themselves, only when `recordAudio` is on (tests). */
  audio: Record<Track, number[]>
  tz: string | undefined
}

// ------------------------------------------------------------------------------------ helpers

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `2026-10-07T15:00:00-04:00`: local time with its offset, as meeting frontmatter stores it. */
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

const yamlString = (s: string) => (/^[A-Za-z0-9][\w .,'()&@<>/-]*$/.test(s) ? s : JSON.stringify(s))

const formatAttendee = (a: { email: string; name?: string | undefined }) =>
  a.name ? `${a.name} <${a.email}>` : a.email

const domainOf = (attendee: string) => /@([^>\s]+)/.exec(attendee)?.[1]?.toLowerCase() ?? null

/** Domains of attendees from outside the company. */
function companiesOf(attendees: string[]): string[] {
  const domains = attendees.map(domainOf).filter((d): d is string => !!d && d !== HOME_DOMAIN)
  return [...new Set(domains)]
}

export interface MeetingFile {
  id: string
  title: string
  date: Date
  durationMin: number
  attendees: string[]
  template: string
  calendarEventId?: string
  transcriptName: string
  aiRanges: Array<[number, number]>
  body: string
}

/** A meeting note's text in the §7.4 layout. */
export function meetingNoteText(m: MeetingFile): string {
  const companies = companiesOf(m.attendees)
  const lines = [
    '---',
    `id: ${m.id}`,
    'type: meeting',
    `title: ${yamlString(m.title)}`,
    `date: ${isoWithOffset(m.date)}`,
    `duration_min: ${m.durationMin}`,
    ...(m.attendees.length > 0
      ? ['attendees:', ...m.attendees.map((a) => `  - ${yamlString(a)}`)]
      : ['attendees: []']),
    `companies: [${companies.join(', ')}]`,
    `template: ${m.template}`,
    ...(m.calendarEventId ? [`calendar_event_id: ${m.calendarEventId}`] : []),
    `transcript: ${m.transcriptName}`,
    `ai_ranges: [${m.aiRanges.map(([a, b]) => `[${a}, ${b}]`).join(', ')}]`,
    'models: {}',
    '---',
  ]
  return `${lines.join('\n')}\n${m.body}`
}

/**
 * Like the server's assembleEnhancedNote: a body line that equals a trimmed, non-empty line
 * of the raw notes is the member's; every other line is AI-written. Ranges are 1-based and
 * inclusive, counted in the body.
 */
export function aiRangesFor(body: string, rawNotes: string): Array<[number, number]> {
  const own = new Set(
    rawNotes
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const lines = body.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const ranges: Array<[number, number]> = []
  let start = 0
  lines.forEach((line, i) => {
    const n = i + 1
    if (!own.has(line)) {
      if (start === 0) start = n
    } else if (start !== 0) {
      ranges.push([start, n - 1])
      start = 0
    }
  })
  if (start !== 0) ranges.push([start, lines.length])
  return ranges
}

export function transcriptText(
  title: string,
  lines: Array<{ at: number; speaker: string; text: string }>,
): string {
  return `# Transcript: ${title}\n\n${lines.map(formatTranscriptLine).join('\n')}\n`
}

/** The transcript that sits next to a note, by the `meetingPaths` naming. */
export const transcriptPathOf = (notePath: string) => notePath.replace(/\.md$/i, '.transcript.md')

const isNotePath = (path: string) =>
  path.startsWith('meetings/') && path.endsWith('.md') && !path.endsWith('.transcript.md')

const STOPWORDS = new Set(
  'the and for with what who did does was were are about from that this have has had how why when where which our your their they them you any all can will would should into than then there these those'.split(
    ' ',
  ),
)

// ------------------------------------------------------------------------------------ calendar

/** The event the seeded "Acme kickoff" note was taken for (its `calendar_event_id`). */
export const ACME_KICKOFF_EVENT = 'evt-acme-kickoff'

export function calendarFixture(now: Date): CalendarEvent[] {
  const at = (ms: number) => new Date(Math.floor((now.getTime() + ms) / 1000) * 1000).toISOString()
  const MIN = 60_000
  // Local wall-clock time some days ago, like the seeded meeting notes' dates.
  const past = (daysAgo: number, hour: number, minute: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, minute, 0, 0)
    return d
  }
  const pastEvent = (
    event: Omit<CalendarEvent, 'start' | 'end'>,
    start: Date,
    minutes: number,
  ): CalendarEvent => ({
    ...event,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * MIN).toISOString(),
  })
  return [
    // Past meetings, for "Recent meetings": one with a note, one without.
    pastEvent(
      {
        id: ACME_KICKOFF_EVENT,
        title: 'Acme kickoff',
        attendees: [
          { email: 'ada@example.test', name: 'Ada Lovelace' },
          { email: 'dana@acme.com', name: 'Dana Lee' },
        ],
        calendarId: 'primary',
      },
      past(1, 10, 0),
      30,
    ),
    pastEvent(
      {
        id: 'evt-bolt-intro',
        title: 'Intro call with Bolt',
        attendees: [
          { email: 'ada@example.test', name: 'Ada Lovelace' },
          { email: 'jo@bolt.io', name: 'Jo Rivera' },
        ],
        calendarId: 'primary',
      },
      past(2, 14, 0),
      30,
    ),
    {
      id: 'evt-acme-sync',
      title: 'Acme sync',
      start: at(MIN),
      end: at(31 * MIN),
      attendees: [
        { email: 'ada@example.test', name: 'Ada Lovelace' },
        { email: 'dana@acme.com', name: 'Dana Lee' },
      ],
      description: 'Follow-up on SSO and the pricing one-pager.',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      seriesId: 'fake-acme-series',
      calendarId: 'primary',
    },
    {
      id: 'evt-weekly-planning',
      title: 'Weekly planning',
      start: at(180 * MIN),
      end: at(225 * MIN),
      attendees: [
        { email: 'ada@example.test', name: 'Ada Lovelace' },
        { email: 'priya@example.test', name: 'Priya Natarajan' },
        { email: 'sam@example.test', name: 'Sam Okafor' },
      ],
      meetLink: 'https://meet.google.com/xyz-wxyz-abc',
      calendarId: 'primary',
    },
  ]
}

/** The member's calendars besides their primary one. */
const EXTRA_CALENDARS: Array<Omit<CalendarChoice, 'selected' | 'primary'>> = [
  { id: 'team@fake', name: 'Acme team', color: '#d06b3c' },
  { id: 'holidays@fake', name: 'US holidays', color: '#5b8a5a' },
]

// ------------------------------------------------------------------------------------ the fake

export class FakeMeetings {
  readonly sessions = new Map<string, FakeSession>()
  readonly events: CalendarEvent[]
  /** blobOid of each note right after its last enhance, keyed `space:path`. */
  readonly enhanced = new Map<string, string>()
  /** Tests: keep the audio bytes each session receives. */
  recordAudio = false
  /** Tests: Stop fails after the session is `stopped`, as a failed push to the host does. */
  failStop = false

  /** What the last calendar sync left; tests set `error` to play a Google outage. */
  calendarStatus: CalendarStatus
  /** Extra calendars each member picked, by email. */
  readonly calendarChoices = new Map<string, Set<string>>()

  constructor(
    private readonly repo: FakeRepo,
    now: Date = new Date(),
  ) {
    this.events = calendarFixture(now)
    this.calendarStatus = { lastSyncedAt: now.toISOString(), error: null }
  }

  /** Like the server's refresh: a sync that succeeds unless `calendarStatus.error` is set. */
  refreshCalendar(now: Date = new Date()): CalendarStatus {
    if (!this.calendarStatus.error) this.calendarStatus.lastSyncedAt = now.toISOString()
    return { ...this.calendarStatus }
  }

  /** §7.8 match: the event with this Meet code nearest now within 12 h, else one happening now. */
  match(code: string, me: string, now: Date = new Date()): CalendarMatch {
    const t = now.getTime()
    const distance = (e: CalendarEvent) => {
      const start = Date.parse(e.start)
      const end = Date.parse(e.end)
      return t < start ? start - t : t > end ? t - end : 0
    }
    const byMeet = this.events
      .filter((e) => meetCallCode(e.meetLink) === code && distance(e) <= 12 * 3_600_000)
      .sort((a, b) => distance(a) - distance(b))[0]
    if (byMeet) return { event: byMeet, by: 'meet' }
    const byNow = this.events
      .filter(
        (e) =>
          Date.parse(e.start) <= t &&
          Date.parse(e.end) > t &&
          e.attendees.some((a) => a.email !== me),
      )
      .sort((a, b) => b.start.localeCompare(a.start))[0]
    return byNow ? { event: byNow, by: 'now' } : { event: null, by: null }
  }

  /** §7.8 coverage: ended in the range, with someone besides the member, newest first. */
  coverage(spaces: string[], me: string, from: string, to: string): CoverageItem[] {
    const lo = Date.parse(from)
    const hi = Date.parse(to)
    // The member's personal space is listed last in `spaces`, and wins.
    const notes = new Map<string, CoverageItem['note']>()
    for (const space of spaces) {
      for (const [path, content] of this.repo.space(space).files) {
        if (!isNotePath(path)) continue
        const { data } = parseFrontmatter(content)
        if (typeof data.calendar_event_id !== 'string') continue
        const title = typeof data.title === 'string' ? data.title : path
        notes.set(data.calendar_event_id, { space, path, title })
      }
    }
    return this.events
      .filter((e) => {
        const end = Date.parse(e.end)
        return end > lo && end <= hi && e.attendees.some((a) => a.email !== me)
      })
      .sort((a, b) => b.start.localeCompare(a.start))
      .map((event) => ({ event, note: notes.get(event.id) ?? null }))
  }

  calendars(email: string): CalendarChoice[] {
    const picked = this.calendarChoices.get(email) ?? new Set()
    return [
      { id: email, name: email, primary: true, selected: true },
      ...EXTRA_CALENDARS.map((c) => ({ ...c, primary: false, selected: picked.has(c.id) })),
    ]
  }

  /** `null` when an id isn't one of the member's calendars. */
  setCalendars(email: string, ids: string[]): CalendarChoice[] | null {
    const known = new Set(EXTRA_CALENDARS.map((c) => c.id))
    const extra = ids.filter((id) => id !== email)
    if (extra.some((id) => !known.has(id))) return null
    this.calendarChoices.set(email, new Set(extra))
    return this.calendars(email)
  }

  upcoming(from: string, to: string): CalendarEvent[] {
    const lo = Date.parse(from)
    const hi = Date.parse(to)
    return this.events
      .filter((e) => Date.parse(e.end) > lo && Date.parse(e.start) < hi)
      .sort((a, b) => a.start.localeCompare(b.start))
  }

  templates(): MeetingTemplate[] {
    return TEMPLATES.map(({ sections: _sections, ...t }) => t)
  }

  create(user: FakeUser, body: CreateSessionBody): FakeSession {
    const now = new Date()
    const event = body.calendarEventId
      ? this.events.find((e) => e.id === body.calendarEventId)
      : undefined
    const session: FakeSession = {
      id: newId(),
      owner: user.email,
      space: user.handle,
      title:
        body.title?.trim() ||
        event?.title ||
        `${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} Meeting`,
      template: templateById(body.template).id,
      ...(event ? { calendarEventId: event.id } : {}),
      ...(body.meetCode ? { meetCode: body.meetCode } : {}),
      startedAt: now.toISOString(),
      state: 'recording',
      rawNotes: '',
      segments: [],
      received: { me: 0, them: 0 },
      audio: { me: [], them: [] },
      tz: body.tz,
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** The session as the API returns it. */
  view(session: FakeSession): MeetingSession {
    const { received: _r, audio: _a, tz: _tz, ...rest } = session
    return { ...rest, segments: [...rest.segments] }
  }

  /**
   * Audio for one track; returns the segments it completes, in order. Like the server, audio
   * that arrives while paused counts too (ARCHITECTURE §7.3).
   */
  receive(id: string, track: Track, pcm: Uint8Array): TranscriptSegment[] {
    const session = this.sessions.get(id)
    if (session?.state !== 'recording' && session?.state !== 'paused') return []
    const before = session.received[track]
    const after = before + pcm.byteLength
    session.received[track] = after
    if (this.recordAudio) session.audio[track].push(...pcm)
    const out: TranscriptSegment[] = []
    const half = BYTES_PER_SEGMENT / 2
    for (let n = Math.floor(before / half) + 1; n * half <= after; n++) {
      const index = Math.ceil(n / 2)
      const segment: TranscriptSegment = {
        track,
        speaker: SPEAKER[track],
        at: (index - 1) * 1000,
        durationMs: 1000,
        text: `${track} segment ${index}`,
        final: n % 2 === 0,
      }
      out.push(segment)
      if (segment.final) {
        const known = session.segments.findIndex((s) => s.track === track && s.at === segment.at)
        if (known === -1) session.segments.push(segment)
        else session.segments[known] = segment
      }
    }
    return out
  }

  /** Simulates the server missing the tail of a track (bytes lost when a connection dropped). */
  loseTail(id: string, track: Track, bytes: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.received[track] = Math.max(0, session.received[track] - bytes)
    if (this.recordAudio) session.audio[track].length = session.received[track]
  }

  stop(id: string, user: FakeUser): StopResult | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const started = new Date(session.startedAt)
    let { note, transcript } = meetingPaths(started, session.title)
    const space = this.repo.space(session.space)
    for (let n = 2; space.files.has(note); n++) {
      ;({ note, transcript } = meetingPaths(started, `${session.title} ${n}`))
    }
    const event = session.calendarEventId
      ? this.events.find((e) => e.id === session.calendarEventId)
      : undefined
    const sections = templateById(session.template).sections
    const raw = session.rawNotes.trim()
    const body = [
      `# ${session.title}`,
      '',
      `## ${sections[0]}`,
      ...(raw ? [raw] : []),
      ...sections.slice(1).flatMap((h) => ['', `## ${h}`]),
      '',
    ].join('\n')
    const text = meetingNoteText({
      id: session.id,
      title: session.title,
      date: started,
      durationMin: Math.max(1, Math.round((Date.now() - started.getTime()) / 60_000)),
      attendees: event?.attendees.map(formatAttendee) ?? [],
      template: session.template,
      ...(event ? { calendarEventId: event.id } : {}),
      transcriptName: transcript.slice(transcript.lastIndexOf('/') + 1),
      aiRanges: [],
      body,
    })
    const lines = session.segments
      .filter((s) => s.final)
      .sort((a, b) => a.at - b.at)
      .map((s) => ({ at: Math.floor(s.at / 1000), speaker: s.speaker, text: s.text }))
    const author: Author = { name: user.name, email: user.email }
    space.commit(
      new Map([
        [note, text],
        [transcript, transcriptText(session.title, lines)],
        [`.hearth/meetings/raw/${session.id}.md`, session.rawNotes],
      ]),
      author,
      `meetings: capture "${session.title}"`,
    )
    session.state = 'saved'
    return { space: session.space, path: note, transcriptPath: transcript }
  }

  list(spaces: string[], filters: MeetingFilters): MeetingSummary[] {
    const out: MeetingSummary[] = []
    const from = filters.from ? Date.parse(filters.from) : -Infinity
    const to = filters.to ? Date.parse(filters.to) : Infinity
    for (const spaceName of filters.space ? spaces.filter((s) => s === filters.space) : spaces) {
      const space = this.repo.space(spaceName)
      for (const [path, content] of space.files) {
        if (!isNotePath(path)) continue
        if (filters.folder && !path.startsWith(`${filters.folder.replace(/\/$/, '')}/`)) continue
        const { data } = parseFrontmatter(content)
        const date = typeof data.date === 'string' ? data.date : ''
        const time = Date.parse(date)
        if (time < from || time >= to) continue
        const attendees = Array.isArray(data.attendees) ? data.attendees.map(String) : []
        const companies = Array.isArray(data.companies) ? data.companies.map(String) : []
        const person = filters.person?.toLowerCase()
        if (person && !attendees.some((a) => a.toLowerCase().includes(person))) continue
        if (filters.company && !companies.includes(filters.company)) continue
        out.push({
          space: spaceName,
          path,
          title: typeof data.title === 'string' ? data.title : path,
          date,
          duration_min: typeof data.duration_min === 'number' ? data.duration_min : null,
          attendees,
          companies,
          template: typeof data.template === 'string' ? data.template : null,
          hasTranscript: space.files.has(transcriptPathOf(path)),
        })
      }
    }
    return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  }

  /** `edited` when the note changed since its last enhance and `force` isn't set. */
  enhance(
    spaceName: string,
    path: string,
    opts: { template?: string | undefined; force?: boolean | undefined },
    author: Author,
  ): EnhanceResult | 'edited' | null {
    const space = this.repo.space(spaceName)
    const text = space.files.get(path)
    if (text === undefined) return null
    const key = `${spaceName}:${path}`
    const last = this.enhanced.get(key)
    if (last && last !== blobOid(text) && !opts.force) return 'edited'

    const { data, body } = parseFrontmatter(text)
    const title = typeof data.title === 'string' ? data.title : 'Meeting'
    const template = templateById(opts.template ?? (data.template as string | undefined))
    const rawPath = `.hearth/meetings/raw/${String(data.id)}.md`
    const rawNotes = space.files.get(rawPath) ?? ''
    const ownLines = rawNotes
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const transcript = parseTranscript(space.files.get(transcriptPathOf(path)) ?? '')
    const attendees = Array.isArray(data.attendees) ? data.attendees.map(String) : []
    const names = attendees.map((a) => a.replace(/\s*<.*>$/, ''))

    const [first, second, ...rest] = template.sections
    const quote = (i: number) => transcript[i % Math.max(1, transcript.length)]?.text
    const modelLines = [
      `# ${title}`,
      '',
      `## ${first}`,
      `- ${title} with ${names.length > 0 ? names.join(', ') : 'the team'}: ${transcript.length} transcript lines and ${ownLines.length} of your notes.`,
      ...(quote(0) ? [`- The conversation opened with “${quote(0)}”.`] : []),
      ...(second ? ['', `## ${second}`] : []),
      ...ownLines.flatMap((line, i) => [
        line,
        `- More from the transcript: “${quote(i + 1) ?? line}”.`,
      ]),
      ...rest.flatMap((h) =>
        /action/i.test(h)
          ? ['', `## ${h}`, '- [ ] Me: send a recap to the attendees (Fri)']
          : ['', `## ${h}`, `- Nothing specific on ${h.toLowerCase()} came up.`],
      ),
      '',
    ]
    const modelMarkdown = modelLines.join('\n')
    const aiRanges = aiRangesFor(modelMarkdown, rawNotes)
    const head = text.slice(0, text.length - body.length)
    const saved = patchFrontmatter(`${head}${modelMarkdown}`, {
      ai_ranges: aiRanges,
      template: template.id,
      models: { enhance: 'fake-llm' },
    })
    space.commit(new Map([[path, saved]]), author, `meetings: enhance "${title}"`)
    this.enhanced.set(key, blobOid(saved))
    return { path, aiRanges, usage: { input: 1200 + transcript.length * 20, output: 240 } }
  }

  chat(spaces: string[], question: string, scope: ChatScope): ChatAnswer {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    type Hit = ChatCitation & { score: number }
    const hits: Hit[] = []
    let fallback: ChatCitation | null = null

    for (const spaceName of scope.space ? spaces.filter((s) => s === scope.space) : spaces) {
      const space = this.repo.space(spaceName)
      const notes = this.list([spaceName], {
        ...(scope.folder ? { folder: scope.folder } : {}),
        ...(scope.person ? { person: scope.person } : {}),
        ...(scope.company ? { company: scope.company } : {}),
      }).filter((m) => !scope.meetingPath || m.path === scope.meetingPath)
      for (const note of notes) {
        for (const path of [note.path, transcriptPathOf(note.path)]) {
          const content = space.files.get(path)
          if (content === undefined) continue
          const { body } = parseFrontmatter(content)
          const lines = content.split('\n')
          const firstBodyLine = lines.length - body.split('\n').length + 1
          lines.forEach((text, i) => {
            const line = i + 1
            if (line < firstBodyLine || !text.trim() || text.startsWith('#')) return
            fallback ??= { space: spaceName, path, line, text }
            const lower = text.toLowerCase()
            const score = terms.filter((t) => lower.includes(t)).length
            if (score > 0) hits.push({ space: spaceName, path, line, text, score })
          })
        }
      }
    }

    // The best line of each file first, so an answer draws on more than one meeting.
    const sorted = hits.sort((a, b) => b.score - a.score)
    const best: Hit[] = []
    const rest: Hit[] = []
    for (const hit of sorted) {
      if (best.some((h) => h.path === hit.path)) rest.push(hit)
      else best.push(hit)
    }
    const ranked = [...best, ...rest].slice(0, 3)
    const citations: ChatCitation[] = ranked.length
      ? ranked.map(({ score: _score, ...c }) => c)
      : fallback
        ? [fallback]
        : []
    if (citations.length === 0) {
      return { answer: 'I couldn’t find anything about that in these meetings.', citations: [] }
    }
    const strip = (text: string) =>
      text
        .replace(/^\[\d{2}:\d{2}:\d{2}\] /, '')
        .replace(/^[-*] (\[[ x]\] )?/, '')
        .replace(/\*\*/g, '')
    const answer = ranked.length
      ? `Here’s what the meetings say. ${citations.map((c, i) => `${strip(c.text)} [${i + 1}]`).join(' ')}`
      : `Nothing matched those words exactly. The closest note: ${strip(citations[0]?.text ?? '')} [1]`
    return { answer, citations }
  }
}
