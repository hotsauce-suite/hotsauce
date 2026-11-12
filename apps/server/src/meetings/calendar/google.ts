import { z } from 'zod'
import type { Principal } from '../../auth/index.js'
import { HearthError } from '../../errors.js'
import type { CalendarEvent } from './types.js'

const API = 'https://www.googleapis.com/calendar/v3'
const MAX_RESULTS = 250
/** A hung Google or Clerk must not hold up reminders for everyone, or a shutdown. */
export const GOOGLE_TIMEOUT_MS = 10_000

/** A member's Google OAuth access token, or null when they haven't granted one. */
export type AccessToken = (principal: Principal) => Promise<string | null>

/** The slice of `@clerk/backend`'s client this uses. */
export interface ClerkOAuthTokens {
  users: {
    getUserOauthAccessToken(
      userId: string,
      provider: 'google',
    ): Promise<{ data: ReadonlyArray<{ token: string; scopes?: string[] | undefined }> }>
  }
}

/** A member's Google token and the scopes it carries (null scopes: Clerk didn't say). */
export interface GoogleGrant {
  token: string
  scopes: string[] | null
}

/** The member's Google grant, or null when they haven't granted one. */
export type GoogleGrantSource = (principal: Principal) => Promise<GoogleGrant | null>

/**
 * The token Clerk holds from the member's Google sign-in (needs the calendar.readonly scope).
 * The scopes it carries are logged once per member and whenever they change: they're the
 * first thing to check when Google refuses (they aren't secret; the token never is logged).
 */
export function clerkGoogleToken(
  clerk: ClerkOAuthTokens,
  log: (message: string) => void = console.log,
): AccessToken {
  const grant = clerkGoogleGrant(clerk, log)
  return async (principal) => (await grant(principal))?.token ?? null
}

/** `clerkGoogleToken` with the scopes: booking links need `calendar.events` (ARCHITECTURE §19). */
export function clerkGoogleGrant(
  clerk: ClerkOAuthTokens,
  log: (message: string) => void = console.log,
): GoogleGrantSource {
  const seenScopes = new Map<string, string>()
  return async (principal) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HearthError('host_error', "Clerk didn't answer for the Google token")),
        GOOGLE_TIMEOUT_MS,
      )
    })
    try {
      const { data } = await Promise.race([
        clerk.users.getUserOauthAccessToken(principal.userId, 'google'),
        timeout,
      ])
      const first = data[0]
      if (first) {
        const scopes = [...(first.scopes ?? [])].sort().join(' ') || '(none reported)'
        if (seenScopes.get(principal.userId) !== scopes) {
          seenScopes.set(principal.userId, scopes)
          log(`google token for ${principal.email}: scopes ${scopes}`)
        }
      }
      return first ? { token: first.token, scopes: first.scopes ? [...first.scopes] : null } : null
    } catch (err) {
      if (err instanceof HearthError) throw err
      // Clerk's errors carry a fresh trace id each time; a stable message is logged once.
      const detail = (err as { errors?: Array<{ code?: string; longMessage?: string }> })
        .errors?.[0]
      const code = detail?.code
      if (code === 'oauth_token_retrieval_error') {
        throw new HearthError(
          'forbidden',
          `Hearth couldn't get a Google token for your account (Clerk: ${detail?.longMessage ?? code}). Sign out, then sign in with Google again and allow calendar access.`,
        )
      }
      throw new HearthError(
        'host_error',
        `Clerk couldn't provide the Google token (${code ?? 'error'})`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

const When = z.looseObject({ dateTime: z.string().optional(), date: z.string().optional() })

export const GoogleEvent = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  hangoutLink: z.string().optional(),
  recurringEventId: z.string().optional(),
  organizer: z.looseObject({ email: z.string().optional() }).optional(),
  start: When.optional(),
  end: When.optional(),
  attendees: z
    .array(
      z.looseObject({
        email: z.string().optional(),
        displayName: z.string().optional(),
        self: z.boolean().optional(),
        resource: z.boolean().optional(),
        responseStatus: z.string().optional(),
      }),
    )
    .optional(),
  conferenceData: z
    .looseObject({
      entryPoints: z
        .array(z.looseObject({ entryPointType: z.string().optional(), uri: z.string().optional() }))
        .optional(),
    })
    .optional(),
})
export type GoogleEvent = z.infer<typeof GoogleEvent>

const GoogleEvents = z.looseObject({
  items: z.array(GoogleEvent).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
})

const GoogleCalendarList = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        primary: z.boolean().optional(),
        backgroundColor: z.string().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
})

/**
 * One item of Google's events list as a CalendarEvent, or null when it isn't a meeting to keep:
 * cancelled, all-day (holidays, out-of-office) and declined events. Rooms aren't attendees.
 * On a calendar that isn't the member's own, `self` is that calendar's owner, so `forMember`
 * names the member: an event counts only when they organize it or are invited and haven't
 * declined.
 */
export function classifyGoogleEvent(item: GoogleEvent, forMember?: string): CalendarEvent | null {
  const start = item.start?.dateTime
  const end = item.end?.dateTime
  if (item.status === 'cancelled' || !start || !end) return null
  if (forMember) {
    const me = forMember.toLowerCase()
    const mine = item.attendees?.find((a) => a.email?.toLowerCase() === me)
    const organizes = item.organizer?.email?.toLowerCase() === me
    if (mine ? mine.responseStatus === 'declined' : !organizes) return null
  } else if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) {
    return null
  }
  const event: CalendarEvent = {
    id: item.id,
    title: item.summary?.trim() || '(No title)',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    attendees: (item.attendees ?? [])
      .filter((a) => a.email && !a.resource)
      .map((a) =>
        a.displayName ? { email: a.email ?? '', name: a.displayName } : { email: a.email ?? '' },
      ),
  }
  if (item.description) event.description = item.description
  const video = item.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri
  const meetLink = item.hangoutLink ?? video
  if (meetLink) event.meetLink = meetLink
  if (item.recurringEventId) event.seriesId = item.recurringEventId
  return event
}

/** A whole events list as CalendarEvents, skipping what `classifyGoogleEvent` drops. */
export function mapGoogleEvents(body: unknown): CalendarEvent[] {
  return GoogleEvents.parse(body)
    .items.map((item) => classifyGoogleEvent(item))
    .filter((e): e is CalendarEvent => e !== null)
}

/** One page of an events list. */
export interface EventsPage {
  items: GoogleEvent[]
  nextPageToken?: string | undefined
  nextSyncToken?: string | undefined
}

export interface GoogleCalendarInfo {
  id: string
  name: string
  primary: boolean
  color?: string
}

/** Google said the sync token is no longer valid (HTTP 410): sync in full again. */
export class SyncTokenExpired extends Error {
  constructor() {
    super('Google Calendar sync token expired')
  }
}

/** The member's Google token was missing or refused. */
export function notConnected(refused: boolean): HearthError {
  return new HearthError(
    'forbidden',
    refused
      ? 'Google Calendar refused access. Sign in with Google again and allow calendar access.'
      : 'Google Calendar is not connected. Sign in with Google again and allow calendar access.',
  )
}

export type EventsQuery =
  | { syncToken: string; pageToken?: string | undefined }
  | { timeMin: string; timeMax: string; pageToken?: string | undefined }

/** The read-only Google Calendar calls the sync makes; `GoogleCalendarHttp` is the real one. */
export interface GoogleCalendarApi {
  listEvents(principal: Principal, calendarId: string, query: EventsQuery): Promise<EventsPage>
  listCalendars(principal: Principal): Promise<GoogleCalendarInfo[]>
}

/**
 * Google Calendar's REST API, read-only (`calendar.readonly`): events lists (full or incremental
 * with sync tokens) and the member's calendar list. Never writes.
 */
export class GoogleCalendarHttp implements GoogleCalendarApi {
  readonly #accessToken: AccessToken
  readonly #fetch: typeof fetch

  constructor(opts: { accessToken: AccessToken; fetch?: typeof fetch }) {
    this.#accessToken = opts.accessToken
    this.#fetch = opts.fetch ?? fetch
  }

  async listEvents(
    principal: Principal,
    calendarId: string,
    query: EventsQuery,
  ): Promise<EventsPage> {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('maxResults', String(MAX_RESULTS))
    if ('syncToken' in query) {
      url.searchParams.set('syncToken', query.syncToken)
    } else {
      url.searchParams.set('timeMin', query.timeMin)
      url.searchParams.set('timeMax', query.timeMax)
    }
    if (query.pageToken) url.searchParams.set('pageToken', query.pageToken)
    return GoogleEvents.parse(await this.#get(principal, url))
  }

  async listCalendars(principal: Principal): Promise<GoogleCalendarInfo[]> {
    const calendars: GoogleCalendarInfo[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${API}/users/me/calendarList`)
      url.searchParams.set('minAccessRole', 'reader')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const page = GoogleCalendarList.parse(await this.#get(principal, url))
      for (const c of page.items) {
        const info: GoogleCalendarInfo = {
          id: c.id,
          name: c.summaryOverride ?? c.summary ?? c.id,
          primary: c.primary === true,
        }
        if (c.backgroundColor) info.color = c.backgroundColor
        calendars.push(info)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return calendars
  }

  async #get(principal: Principal, url: URL): Promise<unknown> {
    const token = await this.#accessToken(principal)
    if (!token) throw notConnected(false)
    let res: Response
    try {
      res = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      })
    } catch (err) {
      throw new HearthError('host_error', `Couldn't reach Google Calendar (${err})`)
    }
    if (res.status === 410) {
      await res.body?.cancel()
      throw new SyncTokenExpired()
    }
    const text = res.ok ? '' : (await res.text()).slice(0, 4000)
    // Google answers a rate limit with 403 too; that isn't a refused grant.
    if (res.status === 401 || (res.status === 403 && !/rateLimitExceeded/i.test(text))) {
      throw refusal(res.status, text)
    }
    if (res.status === 404)
      throw new HearthError('not_found', 'Google Calendar has no such calendar')
    if (!res.ok) {
      throw new HearthError(
        'host_error',
        `Google Calendar request failed (${res.status}) ${text.slice(0, 300)}`,
      )
    }
    return res.json()
  }
}

const GoogleError = z.looseObject({
  error: z
    .looseObject({
      message: z.string().optional(),
      status: z.string().optional(),
      errors: z.array(z.looseObject({ reason: z.string().optional() })).optional(),
      details: z
        .array(
          z.looseObject({
            reason: z.string().optional(),
            metadata: z.record(z.string(), z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})

/**
 * Google's 401 or 403 as the member should read it, with Google's reason in it, so the log and
 * Meetings home say which of three different fixes is needed (§7.8).
 */
export function refusal(status: number, body: string): HearthError {
  let parsed: z.infer<typeof GoogleError>['error']
  try {
    parsed = GoogleError.parse(JSON.parse(body)).error
  } catch {
    parsed = undefined
  }
  const reasons = [
    ...(parsed?.errors ?? []).map((e) => e.reason),
    ...(parsed?.details ?? []).map((d) => d.reason),
    parsed?.status,
  ].filter((r): r is string => Boolean(r))
  const has = (...names: string[]) => reasons.some((r) => names.includes(r))
  const project =
    parsed?.details?.map((d) => d.metadata?.consumer).find(Boolean) ??
    /project (\d+)/.exec(parsed?.message ?? '')?.[1]
  const why = `Google ${status}${reasons.length ? `: ${[...new Set(reasons)].join(', ')}` : ''}`
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return new HearthError(
      'forbidden',
      `The Google Calendar API is turned off in the Google Cloud project behind Hearth's sign-in${project ? ` (${project})` : ''}. Turn it on in Google Cloud console under APIs & Services. (${why})`,
    )
  }
  if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return new HearthError(
      'forbidden',
      `Your Google sign-in doesn't include calendar access. Sign out, then sign in with Google again and allow calendar access. (${why})`,
    )
  }
  return new HearthError(
    'forbidden',
    `Google Calendar refused access. Sign in with Google again and allow calendar access. (${why})`,
  )
}
