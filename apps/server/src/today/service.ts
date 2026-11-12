// The Today page (ARCHITECTURE §16): one read of everything a member has on today, assembled from
// the index and the calendar cache. No Git reads and no model calls, so it stays inside the API
// budget (platform PRD §9) however many files the spaces hold.

import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { Index } from '../index/index.js'
import type { MeetingActionItems } from '../meetings/action-items.js'
import type { CalendarEvent, CalendarSource } from '../meetings/calendar/types.js'
import { attendeeEmail, strings } from '../meetings/list.js'
import { MAX_NOTE_LIST, type Notes, type NoteView } from '../notes/index.js'
import type { Space, SpaceService } from '../spaces/index.js'
import type { Tasks, TaskView } from '../tasks/index.js'

const DAY_MS = 86_400_000
/** Changed docs listed, newest first. */
export const TODAY_DOCS = 10
/** Unfiled notes listed, newest first. */
export const TODAY_NOTES = 10
const PREP_CHARS = 200

export interface TodayMeeting {
  id: string
  title: string
  start: string
  end: string
  attendees: Array<{ email: string; name?: string }>
  meetLink: string | null
  /** The member's note for this event, once there is one. */
  note: { space: string; path: string } | null
  /** From the last note of the same series, else the last one with two or more of the same people. */
  prep: { space: string; path: string; title: string; date: string; line: string } | null
}

export interface TodayView {
  date: string
  meetings: { events: TodayMeeting[]; error: string | null }
  /** Open tasks of the member's due today or before. */
  tasks: TaskView[]
  actionItems: MeetingActionItems[]
  /** Notes from the last day that aren't pinned or labelled. */
  notes: Array<Pick<NoteView, 'space' | 'id' | 'path' | 'title' | 'body' | 'created'>>
  /** Docs that changed in the last day. */
  docs: Array<{ space: string; path: string; title: string; changed: string; team: boolean }>
  /** The latest Briefcast episode, once Briefcast exists. */
  briefcast: null
}

export interface TodayDeps {
  index: Pick<Index, 'listFiles' | 'bodies'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  tasks: Pick<Tasks, 'list' | 'fromMeetings'>
  notes: Pick<Notes, 'list'>
  calendar: CalendarSource
  now?: () => Date
}

interface MeetingFile {
  space: string
  path: string
  title: string
  date: string
  time: number
  attendees: Set<string>
  eventId: string | null
  seriesId: string | null
  personal: boolean
}

export class Today {
  readonly #deps: TodayDeps
  readonly #now: () => Date

  constructor(deps: TodayDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
  }

  /**
   * `from`..`to` is the member's day (their midnight to midnight, as instants) and `date` its
   * calendar date, both from the browser, so "today" is theirs and not the server's.
   */
  async view(
    principal: Principal,
    day: { from: string; to: string; date: string },
  ): Promise<TodayView> {
    const { index, tasks, notes } = this.#deps
    const spaces = await this.#deps.spaces.visibleSpaces(principal)
    const now = this.#now().getTime()
    const meetingFiles = readMeetings(index, spaces)

    const [meetings, due, actionItems, recentNotes] = await Promise.all([
      this.#meetings(principal, day, meetingFiles),
      tasks.list(principal, { status: 'open', mine: true, dueBefore: day.date }, { spaces }),
      tasks.fromMeetings(principal, undefined, { fromIndex: true }),
      notes.list(principal, { limit: MAX_NOTE_LIST }),
    ])

    const since = new Date(now - DAY_MS).toISOString()
    const me = principal.email.toLowerCase()
    // The member's own notes: a teammate's quick note in the team space isn't theirs to file.
    const unfiled = recentNotes
      .filter(
        (n) =>
          n.createdBy.toLowerCase() === me &&
          !n.pinned &&
          n.labels.length === 0 &&
          n.created >= since,
      )
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, TODAY_NOTES)
      .map(({ space, id, path, title, body, created }) => ({
        space,
        id,
        path,
        title,
        body: body.slice(0, 500),
        created,
      }))

    const docs = spaces
      .flatMap((s) =>
        index
          .listFiles({ space: s.name, kind: 'docs' })
          .filter((f) => f.mtime >= since)
          .map((f) => ({
            space: s.name,
            path: f.path,
            title: f.title,
            changed: f.mtime,
            team: s.kind === 'team',
          })),
      )
      .sort((a, b) => b.changed.localeCompare(a.changed) || a.path.localeCompare(b.path))
      .slice(0, TODAY_DOCS)

    return {
      date: day.date,
      meetings,
      tasks: due,
      actionItems,
      notes: unfiled,
      docs,
      briefcast: null,
    }
  }

  async #meetings(
    principal: Principal,
    day: { from: string; to: string },
    files: MeetingFile[],
  ): Promise<TodayView['meetings']> {
    let events: CalendarEvent[]
    try {
      events = await this.#deps.calendar.upcoming(principal, { from: day.from, to: day.to })
    } catch (err) {
      // No calendar grant (or Google down): the rest of Today still loads, and this says why.
      const message =
        err instanceof HearthError ? err.message : 'Your calendar didn’t load right now.'
      return { events: [], error: message }
    }
    const byEvent = new Map<string, MeetingFile>()
    // Own space first, so the member's own note wins over a teammate's.
    for (const f of [...files].sort((a, b) => Number(b.personal) - Number(a.personal)))
      if (f.eventId && !byEvent.has(f.eventId)) byEvent.set(f.eventId, f)
    return {
      error: null,
      events: events.map((e) => {
        const note = byEvent.get(e.id)
        return {
          id: e.id,
          title: e.title,
          start: e.start,
          end: e.end,
          attendees: e.attendees,
          meetLink: e.meetLink ?? null,
          note: note ? { space: note.space, path: note.path } : null,
          prep: this.#prep(e, files),
        }
      }),
    }
  }

  /**
   * T5: the latest note before the event in the same calendar series, else the latest one before
   * it sharing two or more attendees. None of either: no Prep line.
   */
  #prep(event: CalendarEvent, files: MeetingFile[]): TodayMeeting['prep'] {
    const start = Date.parse(event.start)
    const earlier = files
      .filter((f) => f.eventId !== event.id && f.time < start)
      .sort((a, b) => b.time - a.time)
    const people = new Set(event.attendees.map((a) => a.email.toLowerCase()))
    const shared = (f: MeetingFile) => [...f.attendees].filter((a) => people.has(a)).length
    const found =
      (event.seriesId ? earlier.find((f) => f.seriesId === event.seriesId) : undefined) ??
      earlier.find((f) => shared(f) >= 2)
    if (!found) return null
    const body = this.#deps.index.bodies(found.space, [found.path]).get(found.path) ?? ''
    return {
      space: found.space,
      path: found.path,
      title: found.title,
      date: found.date,
      line: prepLine(body),
    }
  }
}

function readMeetings(index: TodayDeps['index'], spaces: Space[]): MeetingFile[] {
  const out: MeetingFile[] = []
  for (const space of spaces) {
    for (const file of index.listFiles({ space: space.name, kind: 'meeting' })) {
      const fm = file.frontmatter
      if (fm?.type !== 'meeting') continue
      const date = typeof fm.date === 'string' ? fm.date : ''
      const time = Date.parse(date)
      if (Number.isNaN(time)) continue
      out.push({
        space: space.name,
        path: file.path,
        title: file.title,
        date,
        time,
        attendees: new Set(strings(fm.attendees).map(attendeeEmail)),
        eventId: typeof fm.calendar_event_id === 'string' ? fm.calendar_event_id : null,
        seriesId: typeof fm.calendar_series_id === 'string' ? fm.calendar_series_id : null,
        personal: space.kind === 'personal',
      })
    }
  }
  return out
}

/** The first line of a note's text worth reading: not a heading, not an empty to-do. */
export function prepLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw
      .trim()
      .replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '')
      .replace(/[*_`]/g, '')
      .trim()
    if (!line || raw.trim().startsWith('#') || line.startsWith('<!--') || line.startsWith('>'))
      continue
    return line.length > PREP_CHARS ? `${line.slice(0, PREP_CHARS - 1)}…` : line
  }
  return ''
}
