import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '../../auth/index.js'
import { FakeCalendar } from './fake.js'
import {
  clerkGoogleToken,
  GoogleCalendarHttp,
  mapGoogleEvents,
  refusal,
  SyncTokenExpired,
} from './google.js'
import { findEvent } from './types.js'

const EVENTS = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/google/events.json', import.meta.url), 'utf8'),
)

const ALICE: Principal = {
  userId: 'user_2abc',
  email: 'alice@example.test',
  name: 'Alice Example',
  handle: 'alice',
  isAdmin: false,
}

describe('mapGoogleEvents', () => {
  it('maps timed events, skipping cancelled, all-day and declined ones and rooms', () => {
    expect(mapGoogleEvents(EVENTS)).toEqual([
      {
        id: '5k2m8v1q9c0acmesync',
        title: 'Acme sync',
        start: '2026-10-08T19:00:00.000Z',
        end: '2026-10-08T19:30:00.000Z',
        attendees: [{ email: 'alice@example.test' }, { email: 'dana@acme.com', name: 'Dana Lee' }],
        description: 'Agenda: SSO timeline, pricing one-pager.',
        meetLink: 'https://meet.google.com/abc-defg-hij',
      },
      {
        id: 'zoomcall1',
        title: '(No title)',
        start: '2026-10-09T13:00:00.000Z',
        end: '2026-10-09T13:45:00.000Z',
        attendees: [
          { email: 'alice@example.test' },
          { email: 'sam@partner.example', name: 'Sam Partner' },
        ],
        meetLink: 'https://zoom.us/j/123456',
      },
    ])
  })

  it('treats a response without items as no events, and rejects a malformed one', () => {
    expect(mapGoogleEvents({ kind: 'calendar#events' })).toEqual([])
    expect(() => mapGoogleEvents({ items: [{ summary: 'no id' }] })).toThrow()
  })
})

describe('GoogleCalendarHttp', () => {
  const ok = (body: unknown) =>
    vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json(body))

  it('lists a window of single events with the member token', async () => {
    const fetch = ok(EVENTS)
    const accessToken = vi.fn(async () => 'ya29.token')
    const google = new GoogleCalendarHttp({ accessToken, fetch: fetch as typeof globalThis.fetch })

    const page = await google.listEvents(ALICE, 'primary', {
      timeMin: '2026-10-08T04:00:00.000Z',
      timeMax: '2026-10-10T04:00:00.000Z',
    })

    expect(page.items.length).toBeGreaterThan(0)
    expect(accessToken).toHaveBeenCalledWith(ALICE)
    const [url, init] = fetch.mock.calls[0] ?? []
    const requested = new URL(String(url))
    expect(requested.origin + requested.pathname).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    )
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      timeMin: '2026-10-08T04:00:00.000Z',
      timeMax: '2026-10-10T04:00:00.000Z',
      singleEvents: 'true',
      maxResults: '250',
    })
    expect(init?.headers).toEqual({ Authorization: 'Bearer ya29.token' })
    // A hung Google can't hold up the reminder pass for everyone.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends only the sync token (and page) on an incremental sync', async () => {
    const fetch = ok({ items: [], nextSyncToken: 'next' })
    const google = new GoogleCalendarHttp({
      accessToken: async () => 't',
      fetch: fetch as typeof globalThis.fetch,
    })
    const page = await google.listEvents(ALICE, 'team@x.com', { syncToken: 's1', pageToken: 'p2' })
    expect(page.nextSyncToken).toBe('next')
    const requested = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(requested.pathname).toBe('/calendar/v3/calendars/team%40x.com/events')
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      syncToken: 's1',
      pageToken: 'p2',
      singleEvents: 'true',
      maxResults: '250',
    })
  })

  it('maps refusals to forbidden, 410 to SyncTokenExpired, and the rest to host_error', async () => {
    const respond = (res: Response | Error, token: string | null = 't') =>
      new GoogleCalendarHttp({
        accessToken: async () => token,
        fetch: (async () => {
          if (res instanceof Error) throw res
          return res
        }) as typeof fetch,
      }).listEvents(ALICE, 'primary', { syncToken: 's' })
    await expect(respond(new Response('{}'), null)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(respond(new Response('no', { status: 401 }))).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      respond(new Response('{"error":"insufficientPermissions"}', { status: 403 })),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      respond(new Response('{"reason":"rateLimitExceeded"}', { status: 403 })),
    ).rejects.toMatchObject({ code: 'host_error' })
    await expect(respond(new Response('gone', { status: 410 }))).rejects.toBeInstanceOf(
      SyncTokenExpired,
    )
    await expect(respond(new Response('oops', { status: 503 }))).rejects.toMatchObject({
      code: 'host_error',
    })
    await expect(respond(new TypeError('fetch failed'))).rejects.toMatchObject({
      code: 'host_error',
    })
  })

  it('lists calendars across pages, naming each by its override', async () => {
    const pages = [
      { items: [{ id: 'a@x.com', summary: 'A', primary: true }], nextPageToken: 'p2' },
      {
        items: [
          { id: 'team', summary: 'Team', summaryOverride: 'Our team', backgroundColor: '#f00' },
        ],
      },
    ]
    const fetch = vi.fn(async () => Response.json(pages.shift()))
    const google = new GoogleCalendarHttp({
      accessToken: async () => 't',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(await google.listCalendars(ALICE)).toEqual([
      { id: 'a@x.com', name: 'A', primary: true },
      { id: 'team', name: 'Our team', primary: false, color: '#f00' },
    ])
  })
})

describe('clerkGoogleToken', () => {
  it('reads the first Google token Clerk holds for the user, or null', async () => {
    const getUserOauthAccessToken = vi.fn(async () => ({
      data: [{ token: 'ya29.a' }, { token: 'b' }],
    }))
    expect(
      await clerkGoogleToken({ users: { getUserOauthAccessToken } })({
        ...ALICE,
        userId: 'user_1',
      }),
    ).toBe('ya29.a')
    expect(getUserOauthAccessToken).toHaveBeenCalledWith('user_1', 'google')
    const none = { users: { getUserOauthAccessToken: async () => ({ data: [] }) } }
    expect(await clerkGoogleToken(none)(ALICE)).toBeNull()
  })

  it('turns Clerk failures into stable errors: a refused Google grant is forbidden', async () => {
    const failing = (code: string) => ({
      users: {
        getUserOauthAccessToken: async () => {
          throw Object.assign(new Error(`trace ${Math.random()}`), { errors: [{ code }] })
        },
      },
    })
    const refused = clerkGoogleToken(failing('oauth_token_retrieval_error'))
    const first = await refused(ALICE).catch((e) => e)
    const second = await refused(ALICE).catch((e) => e)
    expect(first).toMatchObject({ code: 'forbidden' })
    expect(second.message).toBe(first.message)
    await expect(clerkGoogleToken(failing('rate_limited'))(ALICE)).rejects.toMatchObject({
      code: 'host_error',
      message: "Clerk couldn't provide the Google token (rate_limited)",
    })
  })
})

describe('FakeCalendar', () => {
  const now = Date.parse('2026-10-08T14:00:30Z')
  const calendar = new FakeCalendar({ now: () => now })

  it('has two events today, the first starting within two minutes', async () => {
    const events = await calendar.upcoming(ALICE, {
      from: '2026-10-08T00:00:00Z',
      to: '2026-10-09T00:00:00Z',
    })
    expect(events.map((e) => [e.id, e.start])).toEqual([
      ['fake-acme-sync', '2026-10-08T14:02:00.000Z'],
      ['fake-design-review', '2026-10-08T16:02:00.000Z'],
    ])
    expect(events[0]?.attendees).toEqual([
      { email: 'alice@example.test', name: 'Alice Example' },
      { email: 'dana@acme.com', name: 'Dana Lee' },
    ])
  })

  it('filters by range, and finds an event by id around a time', async () => {
    expect(
      await calendar.upcoming(ALICE, { from: '2026-10-08T15:00:00Z', to: '2026-10-08T23:00:00Z' }),
    ).toHaveLength(1)
    expect((await findEvent(calendar, ALICE, 'fake-acme-sync', new Date(now)))?.title).toBe(
      'Acme sync',
    )
    expect(await findEvent(calendar, ALICE, 'nope', new Date(now))).toBeNull()
  })
})

describe('refusal', () => {
  it('names the Calendar API being off, with the project from Google’s error', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message:
          'Google Calendar API has not been used in project 123456789 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        errors: [{ reason: 'accessNotConfigured' }],
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'SERVICE_DISABLED',
            metadata: { consumer: 'projects/123456789', service: 'calendar-json.googleapis.com' },
          },
        ],
      },
    })
    const err = refusal(403, body)
    expect(err.code).toBe('forbidden')
    expect(err.message).toMatch(/Google Calendar API is turned off/)
    expect(err.message).toContain('projects/123456789')
    expect(err.message).toContain('SERVICE_DISABLED')
  })

  it('names a token without the calendar scope, and a plain refusal', () => {
    const scope = refusal(
      403,
      JSON.stringify({
        error: {
          status: 'PERMISSION_DENIED',
          errors: [{ reason: 'insufficientPermissions' }],
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      }),
    )
    expect(scope.message).toMatch(/doesn't include calendar access/)
    const plain = refusal(401, 'not json')
    expect(plain.message).toMatch(/refused access.*\(Google 401\)/)
  })
})

describe('clerkGoogleToken scopes', () => {
  it('logs the token’s scopes once per member, and again when they change', async () => {
    let scopes = ['openid', 'email']
    const log = vi.fn()
    const token = clerkGoogleToken(
      { users: { getUserOauthAccessToken: async () => ({ data: [{ token: 'secret', scopes }] }) } },
      log,
    )
    await token(ALICE)
    await token(ALICE)
    scopes = ['https://www.googleapis.com/auth/calendar.readonly', 'openid']
    await token(ALICE)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'google token for alice@example.test: scopes email openid',
      'google token for alice@example.test: scopes https://www.googleapis.com/auth/calendar.readonly openid',
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
})
