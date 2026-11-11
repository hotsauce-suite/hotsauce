import { nameFromEmail, type Principal } from '../../auth/principal.js'
import { FakeCalendar } from './fake.js'
import type { GoogleEvent } from './google.js'
import type { CalendarEvent } from './types.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
export const FAKE_TEAM_CALENDAR = 'team@fake'
const TOKEN_PREFIX = 'fake-token:'

/** The token the fake Google accepts for a member in dev and test. */
export function fakeGoogleToken(principal: Principal): Promise<string> {
  return Promise.resolve(`${TOKEN_PREFIX}${principal.email.toLowerCase()}`)
}

interface Stored {
  event: GoogleEvent
  /** The change number it was last written at; incremental syncs return changes after a token's. */
  seq: number
}

interface FakeCalendarData {
  name: string
  primary: boolean
  events: Map<string, Stored>
}

interface Member {
  calendars: Map<string, FakeCalendarData>
  /** When the seeded upcoming meetings have all ended, they're seeded again from now. */
  seededUntil: number
}

/**
 * Google Calendar in memory, for dev, test and e2e (ARCHITECTURE §7.8): calendars with events,
 * change numbers behind sync tokens, expired tokens (410), refusals, and pagination. Each member
 * is seeded on first sight; `fakeGoogleFetch` serves it over Google's REST URLs so the real HTTP
 * client and sync run against it.
 */
export class FakeGoogle {
  readonly #now: () => number
  readonly #members = new Map<string, Member>()
  #seq = 0
  /** Sync tokens issued before this change number answer 410. */
  #validFrom = 0
  /** Per member: answer every request with this HTTP status instead (401, 403, 500…). */
  readonly #refusals = new Map<string, number>()
  readonly pageSize: number
  /** Every request served: `<email> <calendar or list> full|incremental|list`. */
  readonly requests: string[] = []

  constructor(opts: { now?: () => number; pageSize?: number; seed?: boolean } = {}) {
    this.#now = opts.now ?? Date.now
    this.pageSize = opts.pageSize ?? 250
    this.#seed = opts.seed ?? true
  }

  readonly #seed: boolean

  /** A member's calendars, seeded (or empty, with `seed: false`) on first sight. */
  member(email: string): Member {
    const key = email.toLowerCase()
    let member = this.#members.get(key)
    if (!member) {
      member = {
        calendars: new Map([
          ['primary', { name: key, primary: true, events: new Map() }],
          [FAKE_TEAM_CALENDAR, { name: 'Team', primary: false, events: new Map() }],
        ]),
        seededUntil: 0,
      }
      this.#members.set(key, member)
      if (this.#seed) {
        member.seededUntil = Number.POSITIVE_INFINITY
        this.#seedPast(key)
        member.seededUntil = 0
      }
    }
    if (this.#seed && this.#now() > member.seededUntil) {
      member.seededUntil = Number.POSITIVE_INFINITY
      this.#seedUpcoming(key)
    }
    return member
  }

  /** Write an event (new or changed) into a calendar. */
  put(email: string, event: GoogleEvent, calendarId = 'primary'): void {
    const calendar = this.member(email).calendars.get(calendarId)
    if (!calendar) throw new Error(`no calendar ${calendarId}`)
    calendar.events.set(event.id, { event, seq: ++this.#seq })
  }

  /** The stored event with this id, from any of the member's calendars. */
  find(email: string, id: string): { event: GoogleEvent; calendarId: string } | null {
    for (const [calendarId, calendar] of this.member(email).calendars) {
      const stored = calendar.events.get(id)
      if (stored) return { event: stored.event, calendarId }
    }
    return null
  }

  /** Move an event by `minutes`, keeping its length. */
  move(email: string, id: string, minutes: number): void {
    const found = this.find(email, id)
    if (!found) throw new Error(`no event ${id}`)
    const shift = (iso: string | undefined) =>
      iso ? new Date(Date.parse(iso) + minutes * MINUTE).toISOString() : iso
    const { event } = found
    this.put(
      email,
      {
        ...event,
        start: { ...event.start, dateTime: shift(event.start?.dateTime) },
        end: { ...event.end, dateTime: shift(event.end?.dateTime) },
      },
      found.calendarId,
    )
  }

  /** Cancel an event: incremental syncs see it as `status: cancelled` with only its id. */
  cancel(email: string, id: string): void {
    const found = this.find(email, id)
    if (!found) throw new Error(`no event ${id}`)
    this.put(email, { id, status: 'cancelled' }, found.calendarId)
  }

  /** Stop sharing a calendar with the member: its requests answer 404. */
  removeCalendar(email: string, calendarId: string): void {
    this.member(email).calendars.delete(calendarId)
  }

  /** Every sync token issued so far answers 410 from now on. */
  expireSyncTokens(): void {
    this.#validFrom = ++this.#seq
  }

  /** Answer the member's requests with `status` until `refuse(email, null)`. */
  refuse(email: string, status: number | null): void {
    if (status === null) this.#refusals.delete(email.toLowerCase())
    else this.#refusals.set(email.toLowerCase(), status)
  }

  /** Google's REST API for this fake, as `fetch`. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const email = auth.startsWith(`Bearer ${TOKEN_PREFIX}`)
      ? auth.slice(`Bearer ${TOKEN_PREFIX}`.length)
      : null
    if (!email) return Response.json({ error: { code: 401 } }, { status: 401 })
    const refusal = this.#refusals.get(email)
    if (refusal) {
      this.requests.push(`${email} refused ${refusal}`)
      return Response.json({ error: { code: refusal } }, { status: refusal })
    }

    const path = url.pathname.replace(/^\/calendar\/v3/, '')
    if (path === '/users/me/calendarList') {
      this.requests.push(`${email} list`)
      return Response.json({
        items: [...this.member(email).calendars].map(([id, c]) => ({
          id: c.primary ? email : id,
          summary: c.name,
          ...(c.primary ? { primary: true } : {}),
        })),
      })
    }
    const match = /^\/calendars\/([^/]+)\/events$/.exec(path)
    if (!match?.[1]) return Response.json({ error: { code: 404 } }, { status: 404 })
    const id = decodeURIComponent(match[1])
    const calendar = this.member(email).calendars.get(id === email ? 'primary' : id)
    if (!calendar) return Response.json({ error: { code: 404 } }, { status: 404 })
    return this.#events(email, id, calendar, url.searchParams)
  }

  #events(email: string, id: string, calendar: FakeCalendarData, q: URLSearchParams): Response {
    const syncToken = q.get('syncToken')
    let items: Stored[]
    if (syncToken) {
      const since = Number(/^fake-sync:(\d+)$/.exec(syncToken)?.[1] ?? Number.NaN)
      this.requests.push(`${email} ${id} incremental`)
      if (!(since >= this.#validFrom)) {
        return Response.json(
          { error: { code: 410, message: 'Sync token is no longer valid' } },
          {
            status: 410,
          },
        )
      }
      items = [...calendar.events.values()].filter((s) => s.seq > since)
    } else {
      const from = Date.parse(q.get('timeMin') ?? '')
      const to = Date.parse(q.get('timeMax') ?? '')
      items = [...calendar.events.values()].filter((s) => {
        if (s.event.status === 'cancelled') return false
        const start = Date.parse(s.event.start?.dateTime ?? s.event.start?.date ?? '')
        const end = Date.parse(s.event.end?.dateTime ?? s.event.end?.date ?? '')
        return end > from && start < to
      })
      this.requests.push(`${email} ${id} full`)
    }
    items.sort((a, b) => a.seq - b.seq)
    const offset = Number(q.get('pageToken') ?? 0)
    const page = items.slice(offset, offset + this.pageSize)
    const more = offset + this.pageSize < items.length
    return Response.json({
      items: page.map((s) => s.event),
      ...(more
        ? { nextPageToken: String(offset + this.pageSize) }
        : { nextSyncToken: `fake-sync:${this.#seq}` }),
    })
  }

  #seedUpcoming(email: string): void {
    const principal = { email, name: nameFromEmail(email) } as Principal
    const events = new FakeCalendar({ now: this.#now }).events(principal)
    for (const event of events) this.put(email, toGoogle(event, email))
    const member = this.#members.get(email)
    if (member) member.seededUntil = Math.max(...events.map((e) => Date.parse(e.end)))
  }

  #seedPast(email: string): void {
    const now = this.#now()
    const at = (daysAgo: number, hour: number) => {
      const d = new Date(now - daysAgo * DAY)
      d.setUTCHours(hour, 0, 0, 0)
      return d.getTime()
    }
    const me = { email, name: nameFromEmail(email) }
    const past = (
      id: string,
      title: string,
      start: number,
      attendees: CalendarEvent['attendees'],
      extra: Partial<CalendarEvent> = {},
    ): CalendarEvent => ({
      id,
      title,
      start: new Date(start).toISOString(),
      end: new Date(start + 30 * MINUTE).toISOString(),
      attendees: [me, ...attendees],
      ...extra,
    })
    const sam = { email: 'sam@example.test', name: 'Sam Rivera' }
    for (const event of [
      past('fake-pipeline_w1', 'Pipeline review', at(8, 15), [sam], { seriesId: 'fake-pipeline' }),
      past('fake-pipeline_w2', 'Pipeline review', at(1, 15), [sam], { seriesId: 'fake-pipeline' }),
      past('fake-bolt-intro', 'Intro call with Bolt', at(2, 17), [
        { email: 'jo@bolt.example', name: 'Jo Park' },
      ]),
    ]) {
      this.put(email, toGoogle(event, email))
    }
    const offsite = toGoogle(past('fake-offsite', 'Offsite planning', at(1, 18), [sam]), email)
    this.put(email, {
      ...offsite,
      attendees: offsite.attendees?.map((a) => (a.self ? { ...a, responseStatus: 'declined' } : a)),
    })
    this.put(
      email,
      toGoogle(past('fake-team-standup', 'Team standup', at(1, 14), [sam]), email),
      FAKE_TEAM_CALENDAR,
    )
  }
}

/** A CalendarEvent as Google would list it to `self`. */
function toGoogle(event: CalendarEvent, self: string): GoogleEvent {
  return {
    id: event.id,
    status: 'confirmed',
    summary: event.title,
    start: { dateTime: event.start },
    end: { dateTime: event.end },
    attendees: event.attendees.map((a) => ({
      email: a.email,
      ...(a.name ? { displayName: a.name } : {}),
      ...(a.email.toLowerCase() === self ? { self: true, responseStatus: 'accepted' } : {}),
    })),
    ...(event.description ? { description: event.description } : {}),
    ...(event.meetLink ? { hangoutLink: event.meetLink } : {}),
    ...(event.seriesId ? { recurringEventId: event.seriesId } : {}),
  }
}
