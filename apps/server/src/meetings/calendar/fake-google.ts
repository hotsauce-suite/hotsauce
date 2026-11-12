import { nameFromEmail, type Principal } from '../../auth/principal.js'
import { FakeCalendar } from './fake.js'
import type { GoogleEvent } from './google.js'
import type { CalendarEvent } from './types.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
export const FAKE_TEAM_CALENDAR = 'team@fake'
const TOKEN_PREFIX = 'fake-token:'
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
export const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

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
  /** Members whose grant lacks `calendar.events` (booking links, ARCHITECTURE §19). */
  readonly #readOnly = new Set<string>()
  #inserted = 0
  /** Every request served: `<email> <calendar or list> full|incremental|list|freebusy|insert`. */
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

  /** Take away (or give back) the member's write scope, as signing in without it would. */
  readOnly(email: string, on = true): void {
    if (on) this.#readOnly.add(email.toLowerCase())
    else this.#readOnly.delete(email.toLowerCase())
  }

  /** The scopes the member's token carries. */
  scopes(email: string): string[] {
    return this.#readOnly.has(email.toLowerCase())
      ? [READONLY_SCOPE]
      : [READONLY_SCOPE, EVENTS_SCOPE]
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
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    if (method === 'POST' && path === '/freeBusy') return this.#freeBusy(email, body)
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
    if (method === 'POST') return this.#insert(email, id, calendar, url.searchParams, body)
    return this.#events(email, id, calendar, url.searchParams)
  }

  #calendarOf(email: string, id: string): FakeCalendarData | undefined {
    return this.member(email).calendars.get(id === email || id === 'primary' ? 'primary' : id)
  }

  /** Busy periods only: no titles, attendees or ids (what Google's freeBusy gives). */
  #freeBusy(email: string, body: unknown): Response {
    const q = body as { timeMin: string; timeMax: string; items: Array<{ id: string }> }
    const from = Date.parse(q.timeMin)
    const to = Date.parse(q.timeMax)
    this.requests.push(`${email} freebusy ${q.items.map((i) => i.id).join(',')}`)
    const calendars: Record<string, unknown> = {}
    for (const { id } of q.items) {
      const calendar = this.#calendarOf(email, id)
      if (!calendar) {
        calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }
        continue
      }
      const busy = [...calendar.events.values()]
        .map((s) => s.event)
        .filter((e) => {
          if (e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime) return false
          if ((e as { transparency?: string }).transparency === 'transparent') return false
          if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return false
          return Date.parse(e.end.dateTime) > from && Date.parse(e.start.dateTime) < to
        })
        .map((e) => ({ start: e.start?.dateTime, end: e.end?.dateTime }))
      calendars[id] = { busy }
    }
    return Response.json({ kind: 'calendar#freeBusy', calendars })
  }

  /** events.insert: a Meet link when asked for (with conferenceDataVersion=1). */
  #insert(
    email: string,
    id: string,
    calendar: FakeCalendarData,
    q: URLSearchParams,
    body: unknown,
  ): Response {
    if (this.#readOnly.has(email)) {
      this.requests.push(`${email} ${id} insert refused`)
      return Response.json(
        { error: { code: 403, message: 'Request had insufficient authentication scopes.' } },
        { status: 403 },
      )
    }
    const input = body as GoogleEvent & {
      conferenceData?: { createRequest?: unknown }
    }
    if (input.id && this.find(email, input.id)) {
      this.requests.push(`${email} ${id} insert duplicate`)
      return Response.json(
        { error: { code: 409, message: 'The requested identifier already exists.' } },
        { status: 409 },
      )
    }
    const n = ++this.#inserted
    const meet =
      q.get('conferenceDataVersion') === '1' && input.conferenceData?.createRequest
        ? `https://meet.google.com/fak-e${String(n).padStart(3, '0')}-mtg`
        : undefined
    const event: GoogleEvent = {
      ...input,
      id: input.id || `booked${n}`,
      status: 'confirmed',
      organizer: { email },
      attendees: [
        { email, self: true, responseStatus: 'accepted' },
        ...(input.attendees ?? []).map((a) => ({ ...a, responseStatus: 'needsAction' })),
      ],
      ...(meet ? { hangoutLink: meet } : {}),
    }
    calendar.events.set(event.id, { event, seq: ++this.#seq })
    this.requests.push(`${email} ${id} insert sendUpdates=${q.get('sendUpdates') ?? 'none'}`)
    return Response.json(event)
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
      for (const filter of q.getAll('privateExtendedProperty')) {
        const [key, value] = filter.split('=')
        items = items.filter(
          (s) =>
            (s.event as { extendedProperties?: { private?: Record<string, string> } })
              .extendedProperties?.private?.[key ?? ''] === value,
        )
      }
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
