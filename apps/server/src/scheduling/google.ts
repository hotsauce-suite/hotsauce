import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { GOOGLE_TIMEOUT_MS, type GoogleGrantSource } from '../meetings/calendar/google.js'

const API = 'https://www.googleapis.com/calendar/v3'
export const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
/** The private extended property that marks an event as booked from a link (its slug). */
export const BOOKING_PROPERTY = 'hearthBooking'

export interface Busy {
  start: string
  end: string
}

export interface NewBooking {
  /** The event's id: a retry with the same one is Google's 409, never a second event. */
  id: string
  slug: string
  title: string
  start: string
  end: string
  description: string
  booker: { name: string; email: string }
  /** Idempotency for the Meet link request. */
  requestId: string
}

/** The Google Calendar calls booking links make (ARCHITECTURE §19). */
export interface BookingGoogle {
  /** Whether the member's grant can write events: false without `calendar.events`. */
  canWrite(principal: Principal): Promise<boolean>
  /** Busy periods across these calendars (freeBusy: no titles or attendees). */
  busy(principal: Principal, calendarIds: string[], from: string, to: string): Promise<Busy[]>
  /** Start times of this link's bookings on the member's primary calendar. */
  booked(principal: Principal, slug: string, from: string, to: string): Promise<string[]>
  /** One event with a Meet link and the booker as attendee; Google emails both sides. */
  insert(
    principal: Principal,
    booking: NewBooking,
  ): Promise<{ id: string; meetLink: string | null }>
}

const FreeBusy = z.looseObject({
  calendars: z
    .record(
      z.string(),
      z.looseObject({
        busy: z.array(z.looseObject({ start: z.string(), end: z.string() })).default([]),
        errors: z.array(z.unknown()).optional(),
      }),
    )
    .default({}),
})

const Listed = z.looseObject({
  items: z
    .array(
      z.looseObject({
        status: z.string().optional(),
        start: z.looseObject({ dateTime: z.string().optional() }).optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
})

const Inserted = z.looseObject({
  id: z.string(),
  hangoutLink: z.string().optional(),
  conferenceData: z
    .looseObject({
      entryPoints: z
        .array(z.looseObject({ entryPointType: z.string().optional(), uri: z.string().optional() }))
        .optional(),
    })
    .optional(),
})

/** Google Calendar's REST API for booking links, with the member's own grant. */
export class GoogleBookingHttp implements BookingGoogle {
  readonly #grant: GoogleGrantSource
  readonly #fetch: typeof fetch

  constructor(opts: { grant: GoogleGrantSource; fetch?: typeof fetch }) {
    this.#grant = opts.grant
    this.#fetch = opts.fetch ?? fetch
  }

  async canWrite(principal: Principal): Promise<boolean> {
    const grant = await this.#grant(principal)
    if (!grant) return false
    // Clerk didn't say which scopes: let Google decide when it's used.
    return grant.scopes === null || grant.scopes.includes(EVENTS_SCOPE)
  }

  async busy(
    principal: Principal,
    calendarIds: string[],
    from: string,
    to: string,
  ): Promise<Busy[]> {
    const ids = calendarIds.length > 0 ? calendarIds.slice(0, 50) : ['primary']
    const res = FreeBusy.parse(
      await this.#call(principal, 'POST', new URL(`${API}/freeBusy`), {
        timeMin: from,
        timeMax: to,
        items: ids.map((id) => ({ id })),
      }),
    )
    // A calendar Google couldn't read would look free: refuse rather than offer its times.
    const failed = Object.entries(res.calendars).find(([, c]) => (c.errors?.length ?? 0) > 0)
    if (failed) {
      throw new HearthError('host_error', `Google couldn't read calendar ${failed[0]}'s free/busy`)
    }
    return Object.values(res.calendars).flatMap((c) =>
      c.busy.map((b) => ({ start: b.start, end: b.end })),
    )
  }

  async booked(principal: Principal, slug: string, from: string, to: string): Promise<string[]> {
    const starts: string[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${API}/calendars/primary/events`)
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('timeMin', from)
      url.searchParams.set('timeMax', to)
      url.searchParams.set('privateExtendedProperty', `${BOOKING_PROPERTY}=${slug}`)
      url.searchParams.set('maxResults', '250')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const page = Listed.parse(await this.#call(principal, 'GET', url))
      for (const e of page.items) {
        if (e.status !== 'cancelled' && e.start?.dateTime) starts.push(e.start.dateTime)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return starts
  }

  async insert(
    principal: Principal,
    b: NewBooking,
  ): Promise<{ id: string; meetLink: string | null }> {
    const url = new URL(`${API}/calendars/primary/events`)
    url.searchParams.set('conferenceDataVersion', '1')
    url.searchParams.set('sendUpdates', 'all')
    const res = Inserted.parse(
      await this.#call(principal, 'POST', url, {
        id: b.id,
        summary: b.title,
        description: b.description,
        start: { dateTime: b.start },
        end: { dateTime: b.end },
        attendees: [{ email: b.booker.email, displayName: b.booker.name }],
        conferenceData: {
          createRequest: {
            requestId: b.requestId,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
        extendedProperties: { private: { [BOOKING_PROPERTY]: b.slug } },
        reminders: { useDefault: true },
      }),
    )
    const video = res.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    return { id: res.id, meetLink: res.hangoutLink ?? video ?? null }
  }

  async #call(principal: Principal, method: string, url: URL, body?: unknown): Promise<unknown> {
    const grant = await this.#grant(principal)
    if (!grant) throw new HearthError('forbidden', 'Google Calendar is not connected')
    let res: Response
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${grant.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      })
    } catch (err) {
      throw new HearthError('host_error', `Couldn't reach Google Calendar (${err})`)
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      if (res.status === 401 || (res.status === 403 && !/rateLimitExceeded/i.test(text))) {
        throw new HearthError('forbidden', `Google Calendar refused (${res.status}) ${text}`)
      }
      if (res.status === 409) throw new HearthError('conflict', 'That event already exists')
      throw new HearthError('host_error', `Google Calendar request failed (${res.status}) ${text}`)
    }
    return res.json()
  }
}
