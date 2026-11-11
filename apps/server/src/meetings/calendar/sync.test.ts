import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '../../auth/index.js'
import { CalendarCache } from './cache.js'
import { FAKE_TEAM_CALENDAR, FakeGoogle, fakeGoogleToken } from './fake-google.js'
import { GoogleCalendarHttp, type GoogleEvent } from './google.js'
import { CachedCalendar, CalendarSync } from './sync.js'
import { coverage, matchMeetEvent } from './views.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ALICE: Principal = {
  userId: 'user_alice',
  email: 'alice@example.test',
  name: 'Alice Example',
  handle: 'alice',
  isAdmin: false,
}
const BOB: Principal = { ...ALICE, userId: 'user_bob', email: 'bob@example.test', handle: 'bob' }

let now: number
let google: FakeGoogle
let cache: CalendarCache
let sync: CalendarSync
let calendar: CachedCalendar
let log: ReturnType<typeof vi.fn<(message: string) => void>>

function build(opts: { seed?: boolean; pageSize?: number } = {}) {
  google = new FakeGoogle({ now: () => now, ...opts })
  cache = new CalendarCache(':memory:')
  log = vi.fn<(message: string) => void>()
  sync = new CalendarSync({
    cache,
    google: new GoogleCalendarHttp({ accessToken: fakeGoogleToken, fetch: google.fetch }),
    now: () => now,
    log,
  })
  calendar = new CachedCalendar(sync)
}

beforeEach(() => {
  now = Date.parse('2026-11-10T14:00:30Z')
  build()
})
afterEach(() => cache.close())

const window = (from = now - DAY, to = now + DAY) => ({
  from: new Date(from).toISOString(),
  to: new Date(to).toISOString(),
})
const ids = async (p = ALICE, range = window()) =>
  (await calendar.upcoming(p, range)).map((e) => e.id)

function meeting(id: string, start: number, extra: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    summary: id,
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(start + 30 * MINUTE).toISOString() },
    attendees: [
      { email: ALICE.email, self: true, responseStatus: 'accepted' },
      { email: 'dana@acme.com' },
    ],
    ...extra,
  }
}

describe('CalendarSync and CachedCalendar', () => {
  it('syncs in full on first read, then serves from the cache without asking Google', async () => {
    expect(await ids()).toEqual(['fake-pipeline_w2', 'fake-acme-sync', 'fake-design-review'])
    expect(google.requests).toEqual([`${ALICE.email} primary full`])
    await ids()
    expect(google.requests).toHaveLength(1)
    const acme = (await calendar.upcoming(ALICE, window())).find((e) => e.id === 'fake-acme-sync')
    expect(acme).toMatchObject({
      title: 'Acme sync',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      seriesId: 'fake-acme-series',
    })
  })

  it('leaves out declined and cancelled events, and keeps another member’s calendar apart', async () => {
    expect(await ids(ALICE, window(now - 2 * DAY, now))).not.toContain('fake-offsite')
    google.put(BOB.email, meeting('bob-only', now + HOUR))
    expect(await ids(BOB)).toContain('bob-only')
    expect(await ids(ALICE)).not.toContain('bob-only')
  })

  it('follows moves, cancellations and declines incrementally', async () => {
    await ids()
    google.move(ALICE.email, 'fake-acme-sync', 45)
    google.cancel(ALICE.email, 'fake-design-review')
    google.put(ALICE.email, meeting('late-add', now + 3 * HOUR))
    await sync.sync(ALICE)
    expect(google.requests.at(-1)).toBe(`${ALICE.email} primary incremental`)
    const events = await calendar.upcoming(ALICE, window())
    expect(events.map((e) => e.id)).toEqual(['fake-pipeline_w2', 'fake-acme-sync', 'late-add'])
    const acme = events.find((e) => e.id === 'fake-acme-sync')
    expect(Date.parse(acme?.start ?? '')).toBe(Date.parse('2026-11-10T14:02:00Z') + 45 * MINUTE)

    google.put(
      ALICE.email,
      meeting('late-add', now + 3 * HOUR, {
        attendees: [{ email: ALICE.email, self: true, responseStatus: 'declined' }],
      }),
    )
    await sync.sync(ALICE)
    expect(await ids()).not.toContain('late-add')
  })

  it('syncs in full again in the same pass when Google says the token expired (410)', async () => {
    await ids()
    google.move(ALICE.email, 'fake-acme-sync', 10)
    google.expireSyncTokens()
    await sync.sync(ALICE)
    expect(google.requests.slice(-2)).toEqual([
      `${ALICE.email} primary incremental`,
      `${ALICE.email} primary full`,
    ])
    const acme = (await calendar.upcoming(ALICE, window())).find((e) => e.id === 'fake-acme-sync')
    expect(Date.parse(acme?.start ?? '')).toBe(Date.parse('2026-11-10T14:12:00Z'))
    expect(cache.status(ALICE.userId).error).toBeNull()
    // The token from that full sync works.
    await sync.sync(ALICE)
    expect(google.requests.at(-1)).toBe(`${ALICE.email} primary incremental`)
  })

  it('syncs in full once a day, so events entering the horizon appear', async () => {
    await ids()
    now += DAY
    await sync.sync(ALICE)
    expect(google.requests.at(-1)).toBe(`${ALICE.email} primary full`)
  })

  it('follows page tokens on full and incremental syncs', async () => {
    build({ pageSize: 2 })
    expect(await ids(ALICE, window(now - 30 * DAY, now + 14 * DAY))).toHaveLength(5)
    for (let i = 0; i < 5; i++) google.put(ALICE.email, meeting(`m${i}`, now + (i + 2) * HOUR))
    await sync.sync(ALICE)
    expect(await ids(ALICE, window(now, now + DAY))).toEqual(
      expect.arrayContaining(['m0', 'm1', 'm2', 'm3', 'm4']),
    )
  })

  it('a member with no events gets an empty calendar, not an error', async () => {
    build({ seed: false })
    expect(await ids()).toEqual([])
    expect(cache.status(ALICE.userId)).toMatchObject({ error: null })
    expect(cache.status(ALICE.userId).syncedAt).toBe(now)
  })

  it('throws a refused grant before the first sync, then keeps the cache through failures', async () => {
    google.refuse(ALICE.email, 403)
    await expect(calendar.upcoming(ALICE, window())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(calendar.upcoming(ALICE, window())).rejects.toMatchObject({ code: 'forbidden' })
    expect(log).toHaveBeenCalledTimes(1)

    google.refuse(ALICE.email, null)
    // Within a minute of the failure, reads don't ask Google again.
    await expect(calendar.upcoming(ALICE, window())).rejects.toMatchObject({ code: 'forbidden' })
    expect(google.requests).toHaveLength(1)
    now += MINUTE
    expect(await ids()).toHaveLength(3)
    google.refuse(ALICE.email, 401)
    for (let i = 0; i < 3; i++) await sync.refresh(ALICE, { maxAgeMs: 0 })
    expect(await ids()).toHaveLength(3)
    expect(cache.status(ALICE.userId)).toMatchObject({
      syncedAt: now,
      error: expect.stringMatching(/refused access/),
    })
    expect(log).toHaveBeenCalledTimes(2)
    google.refuse(ALICE.email, 500)
    await sync.refresh(ALICE, { maxAgeMs: 0 })
    expect(log).toHaveBeenCalledTimes(3)
    expect(cache.status(ALICE.userId).error).toMatch(/failed \(500\)/)
    google.refuse(ALICE.email, null)
    await sync.refresh(ALICE, { maxAgeMs: 0 })
    expect(cache.status(ALICE.userId).error).toBeNull()
  })

  it('refresh skips Google when the last attempt is recent', async () => {
    await ids()
    await sync.refresh(ALICE, { maxAgeMs: MINUTE })
    expect(google.requests).toHaveLength(1)
    now += MINUTE
    await sync.refresh(ALICE, { maxAgeMs: MINUTE })
    expect(google.requests).toHaveLength(2)
  })

  it('joins a pass already running instead of doubling it', async () => {
    await Promise.all([sync.sync(ALICE), sync.sync(ALICE), calendar.upcoming(ALICE, window())])
    expect(google.requests).toHaveLength(1)
  })

  it('syncs every registered member, one failing without stopping the rest', async () => {
    await ids(ALICE)
    await ids(BOB)
    google.refuse(ALICE.email, 403)
    google.put(BOB.email, meeting('bob-new', now + HOUR))
    await sync.syncAll()
    expect(await ids(BOB)).toContain('bob-new')
    expect(cache.status(ALICE.userId).error).toMatch(/refused/)
  })

  it('adds and drops extra calendars; an event in two calendars is listed once', async () => {
    await ids()
    cache.setCalendars(ALICE.userId, [FAKE_TEAM_CALENDAR])
    google.put(ALICE.email, meeting('fake-acme-sync', now + 5 * HOUR), FAKE_TEAM_CALENDAR)
    await sync.sync(ALICE)
    const events = await calendar.upcoming(ALICE, window(now - 2 * DAY, now + DAY))
    expect(events.find((e) => e.id === 'fake-team-standup')?.calendarId).toBe(FAKE_TEAM_CALENDAR)
    const acme = events.filter((e) => e.id === 'fake-acme-sync')
    expect(acme).toHaveLength(1)
    expect(acme[0]?.calendarId).toBeUndefined()

    cache.setCalendars(ALICE.userId, [])
    expect(await ids(ALICE, window(now - 2 * DAY, now + DAY))).not.toContain('fake-team-standup')
    expect(cache.syncState(ALICE.userId, FAKE_TEAM_CALENDAR).syncToken).toBeNull()
  })

  it('on another calendar, keeps only meetings the member is invited to and hasn’t declined', async () => {
    await ids()
    cache.setCalendars(ALICE.userId, [FAKE_TEAM_CALENDAR])
    const colleague = { email: 'sam@example.test', self: true, responseStatus: 'accepted' }
    google.put(
      ALICE.email,
      meeting('declined-there', now + HOUR, {
        attendees: [colleague, { email: ALICE.email, responseStatus: 'declined' }],
      }),
      FAKE_TEAM_CALENDAR,
    )
    google.put(
      ALICE.email,
      meeting('not-invited', now + HOUR, { attendees: [colleague, { email: 'x@y.com' }] }),
      FAKE_TEAM_CALENDAR,
    )
    google.put(
      ALICE.email,
      meeting('organized', now + 2 * HOUR, {
        attendees: [colleague],
        organizer: { email: ALICE.email },
      }),
      FAKE_TEAM_CALENDAR,
    )
    google.put(
      ALICE.email,
      meeting('invited', now + 3 * HOUR, { attendees: [colleague, { email: ALICE.email }] }),
      FAKE_TEAM_CALENDAR,
    )
    await sync.sync(ALICE)
    const got = await ids()
    expect(got).toEqual(expect.arrayContaining(['organized', 'invited']))
    expect(got).not.toContain('declined-there')
    expect(got).not.toContain('not-invited')
  })

  it('drops an extra calendar Google no longer shares, and keeps syncing the rest', async () => {
    await ids()
    cache.setCalendars(ALICE.userId, [FAKE_TEAM_CALENDAR])
    await sync.sync(ALICE)
    google.removeCalendar(ALICE.email, FAKE_TEAM_CALENDAR)
    google.put(ALICE.email, meeting('primary-new', now + HOUR))
    await sync.sync(ALICE)
    expect(cache.calendars(ALICE.userId)).toEqual(['primary'])
    expect(await ids()).toContain('primary-new')
    expect(cache.status(ALICE.userId).error).toBeNull()
  })

  it('removes a whole series’ instances when the series itself is removed', async () => {
    await ids(ALICE, window(now - 30 * DAY, now))
    cache.applyChanges(
      ALICE.userId,
      'primary',
      { upserts: [], removals: ['fake-pipeline'] },
      't',
      now,
    )
    const left = cache.events(ALICE.userId, 0, now + DAY).map((e) => e.id)
    expect(left).not.toContain('fake-pipeline_w1')
    expect(left).not.toContain('fake-pipeline_w2')
    expect(left).toContain('fake-bolt-intro')
  })

  it('a sync of a calendar unticked meanwhile writes nothing back', async () => {
    await ids()
    cache.replaceEvents(ALICE.userId, FAKE_TEAM_CALENDAR, [], 'tok', now)
    expect(cache.syncState(ALICE.userId, FAKE_TEAM_CALENDAR).syncToken).toBeNull()
  })

  it('prunes events that ended more than 30 days ago', async () => {
    await ids()
    expect(cache.events(ALICE.userId, 0, now).map((e) => e.id)).toContain('fake-pipeline_w1')
    now += 25 * DAY
    await sync.sync(ALICE)
    expect(cache.events(ALICE.userId, 0, now).map((e) => e.id)).not.toContain('fake-pipeline_w1')
  })
})

describe('matchMeetEvent', () => {
  const at = (minutes: number) => new Date(now + minutes * MINUTE).toISOString()
  const event = (id: string, start: number, end: number, meetLink?: string, others = true) => ({
    id,
    title: id,
    start: at(start),
    end: at(end),
    attendees: others
      ? [{ email: ALICE.email }, { email: 'x@y.com' }]
      : [{ email: ALICE.email.toUpperCase() }],
    ...(meetLink ? { meetLink } : {}),
  })
  const link = 'https://meet.google.com/abc-defg-hij'

  it('matches the Meet code nearest to now within 12 hours', () => {
    const events = [
      event('last-week', -7 * 24 * 60, -7 * 24 * 60 + 30, link),
      event('tomorrow', 20 * 60, 20 * 60 + 30, link),
      event('soon', 30, 60, link),
    ]
    expect(matchMeetEvent(events, 'abc-defg-hij', ALICE.email, now)).toMatchObject({
      by: 'meet',
      event: { id: 'soon' },
    })
  })

  it('falls back to the meeting overlapping now that started last, else null', () => {
    const events = [
      event('long', -60, 60),
      event('focus', -5, 30, undefined, false),
      event('started', -10, 20),
      event('other-call', -5, 20, 'https://meet.google.com/zzz-zzzz-zzz'),
      event('later', 30, 60),
    ]
    // A call with a different Meet link isn't this call.
    expect(matchMeetEvent(events, 'abc-defg-hij', ALICE.email, now)).toMatchObject({
      by: 'now',
      event: { id: 'started' },
    })
    expect(matchMeetEvent(events, '', ALICE.email, now)).toMatchObject({
      by: 'now',
      event: { id: 'other-call' },
    })
    expect(matchMeetEvent([event('later', 30, 60)], 'abc', ALICE.email, now)).toEqual({
      event: null,
      by: null,
    })
  })
})

describe('coverage', () => {
  it('lists ended meetings with others, newest first, each with its note or null', () => {
    const e = (id: string, startMin: number, others = true) => ({
      id,
      title: id,
      start: new Date(now + startMin * MINUTE).toISOString(),
      end: new Date(now + (startMin + 30) * MINUTE).toISOString(),
      attendees: others ? [{ email: ALICE.email }, { email: 'x@y.com' }] : [{ email: ALICE.email }],
    })
    const note = { space: 'alice', path: 'meetings/a.md', title: 'A' }
    const items = coverage(
      [e('old', -3000), e('solo', -200, false), e('recent', -100), e('running', -10)],
      new Map([['recent', note]]),
      ALICE.email,
      now,
    )
    expect(items.map((i) => [i.event.id, i.note])).toEqual([
      ['recent', note],
      ['old', null],
    ])
  })
})
