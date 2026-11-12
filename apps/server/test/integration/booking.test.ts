import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { FakeLLM } from '../../src/meetings/index.js'
import { FakeRobotCheck, Turnstile } from '../../src/scheduling/index.js'
import { createServices, robotCheckFor, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Booking links (ARCHITECTURE §19, plan S2–S8) through the API with dev auth, against the
// in-memory Google and the dev robot check, as `pnpm dev` and e2e run them.

const ALICE = 'alice@example.test'
const DAY = 86_400_000

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-booking-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    WEBHOOK_SECRET: 'test-webhook-secret',
  })
  services = createServices(config, { llm: new FakeLLM(() => '## Summary\n\n- talked') })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  await removeDir(root)
})

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string | null; json?: unknown; status?: number; ip?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.as !== null) headers['x-hearth-dev-user'] = opts.as ?? ALICE
  if (opts.ip) headers['fly-client-ip'] = opts.ip
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

const WEEKDAY: Array<[string, string]> = [['09:00', '17:00']]
const link = (o: Record<string, unknown> = {}) => ({
  title: 'Intro call',
  minutes: 30,
  tz: 'UTC',
  hours: { sun: [], mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: [] },
  bufferBefore: 0,
  bufferAfter: 0,
  noticeMinutes: 0,
  horizonDays: 60,
  dailyCap: null,
  questions: ['What would you like to talk about?'],
  description: 'A first chat.',
  active: true,
  blobOid: null,
  ...o,
})

/** Monday 00:00 UTC, two weeks out: clear of notice, inside the horizon. */
function mondayAfterNext(): number {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  const toMonday = (8 - d.getUTCDay()) % 7 || 7
  return d.getTime() + (toMonday + 7) * DAY
}
const iso = (ms: number) => new Date(ms).toISOString()
const at = (day: number, hour: number, minute = 0) =>
  iso(mondayAfterNext() + day * DAY + (hour * 60 + minute) * 60_000)

async function makeLink(o: Record<string, unknown> = {}, slug = 'intro') {
  return api('PUT', `/api/booking/${slug}`, { json: link(o) })
}

const week = () => `from=${iso(mondayAfterNext())}&to=${iso(mondayAfterNext() + 7 * DAY)}`
const page = (slug = 'intro', status = 200) =>
  api('GET', `/api/book/alice/${slug}?${week()}`, { as: null, status })
const book = (start: string, o: Record<string, unknown> = {}, status = 200, ip = '203.0.113.1') =>
  api('POST', '/api/book/alice/intro', {
    as: null,
    ip,
    status,
    json: {
      start,
      name: 'Jo Park',
      email: 'jo@bolt.example',
      answers: ['Pricing'],
      token: 'dev-pass',
      ...o,
    },
  })

describe('booking links (signed in)', () => {
  it('S7: without the write scope a member sees the steps and cannot make a link', async () => {
    services.meetings.fakeGoogle?.readOnly(ALICE)
    expect(await api('GET', '/api/booking')).toMatchObject({
      ready: false,
      missing: 'scope',
      handle: 'alice',
      links: [],
    })
    const refused = await api('PUT', '/api/booking/intro', { json: link(), status: 403 })
    expect(refused.error.message).toMatch(/Turn on booking links/)
    services.meetings.fakeGoogle?.readOnly(ALICE, false)
    expect(await api('GET', '/api/booking')).toMatchObject({ ready: true, missing: null })
  })

  it('saves a link as a file in the personal space; stale and duplicate saves are refused', async () => {
    const made = await makeLink()
    expect(made).toMatchObject({ slug: 'intro', title: 'Intro call', minutes: 30, tz: 'UTC' })
    const file = await services.git.readFile('alice', '.hearth/booking/intro.md')
    expect(file.content).toMatch(/^---\ntitle: Intro call\nminutes: 30\n/)
    expect((await api('GET', '/api/booking')).links.map((l: { slug: string }) => l.slug)).toEqual([
      'intro',
    ])
    await api('PUT', '/api/booking/intro', { json: link(), status: 409 })
    const edited = await api('PUT', '/api/booking/intro', {
      json: link({ title: 'Intro chat', blobOid: made.blobOid }),
    })
    expect(edited.title).toBe('Intro chat')
    await api('PUT', '/api/booking/intro', { json: link({ blobOid: made.blobOid }), status: 409 })
    await api('PUT', '/api/booking/intro', { json: link({ minutes: 20 }), status: 400 })
    await api('PUT', '/api/booking/Bad_Name', { json: link(), status: 400 })
    await api('DELETE', `/api/booking/intro?blobOid=${edited.blobOid}`, { status: 204 })
    expect((await api('GET', '/api/booking')).links).toEqual([])
    await page('intro', 404)
  })
})

describe('the public booking page', () => {
  it('S2: lists only free slots, signed out, and reads nothing but busy times', async () => {
    await makeLink()
    services.meetings.fakeGoogle?.put(ALICE, {
      id: 'secret-board-meeting',
      status: 'confirmed',
      summary: 'Secret board meeting',
      description: 'Confidential agenda',
      start: { dateTime: at(0, 10) },
      end: { dateTime: at(0, 11) },
      attendees: [{ email: 'board@example.test' }],
    })
    const body = await page()
    expect(body).toMatchObject({
      title: 'Intro call',
      minutes: 30,
      ownerName: expect.any(String),
      questions: ['What would you like to talk about?'],
      robotCheck: { kind: 'dev' },
      canTakeBookings: true,
    })
    const starts = body.slots.map((s: { start: string }) => s.start)
    expect(starts).toContain(at(0, 9))
    expect(starts).toContain(at(0, 9, 30))
    expect(starts).not.toContain(at(0, 10))
    expect(starts).not.toContain(at(0, 10, 30))
    expect(starts).toContain(at(0, 11))
    expect(starts.filter((s: string) => s.startsWith(at(5, 0).slice(0, 10)))).toEqual([]) // Saturday
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/Secret|Confidential|board@/)
    // Busy times come from freeBusy; no listing of the member's events beyond bookings' own.
    const requests = services.meetings.fakeGoogle?.requests ?? []
    expect(requests.some((r) => r.includes('freebusy'))).toBe(true)
    // A link that isn't there, or is turned off, is a 404.
    await page('nope', 404)
    const off = await api('GET', '/api/booking')
    await api('PUT', '/api/booking/intro', {
      json: link({ active: false, blobOid: off.links[0].blobOid }),
    })
    await page('intro', 404)
  })

  it('S3 + S6: a valid robot check books one event with a Meet link; the answers are the context', async () => {
    await makeLink()
    await book(at(1, 14), { token: '' }, 403)
    await book(at(1, 14), { token: 'forged' }, 403)
    const booked = await book(at(1, 14))
    expect(booked).toEqual({
      start: at(1, 14),
      end: at(1, 14, 30),
      meetLink: expect.stringMatching(/^https:\/\/meet\.google\.com\//),
    })
    const fake = services.meetings.fakeGoogle
    const requests = fake?.requests ?? []
    expect(requests.filter((r) => r.includes('insert'))).toEqual([
      `${ALICE} primary insert sendUpdates=all`,
    ])
    const event = [...(fake?.member(ALICE).calendars.get('primary')?.events.values() ?? [])]
      .map((x) => x.event)
      .find((e) => e.summary === 'Intro call: Jo Park')
    expect(event?.attendees?.map((a) => a.email)).toEqual([ALICE, 'jo@bolt.example'])
    expect(event?.description).toContain('Pricing')
    // The slot is gone from the page.
    const starts = (await page()).slots.map((s: { start: string }) => s.start)
    expect(starts).not.toContain(at(1, 14))
    // S6: it syncs into Meetings like any event, the answers in its description.
    await api('POST', '/api/test/calendar/sync')
    const events = await api('GET', `/api/calendar/upcoming?from=${at(1, 0)}&to=${at(2, 0)}`)
    const meeting = events.find((e: { id: string }) => e.id === event?.id)
    expect(meeting).toMatchObject({
      title: 'Intro call: Jo Park',
      meetLink: booked.meetLink,
      description: expect.stringContaining('What would you like to talk about?\nPricing'),
    })
    expect(meeting.attendees.map((a: { email: string }) => a.email)).toContain('jo@bolt.example')
  })

  it('S4: a slot taken between page load and submit is refused', async () => {
    await makeLink()
    const starts = (await page()).slots.map((s: { start: string }) => s.start)
    expect(starts).toContain(at(2, 9))
    // Someone puts a meeting there meanwhile.
    services.meetings.fakeGoogle?.put(ALICE, {
      id: 'just-added',
      status: 'confirmed',
      summary: 'Added',
      start: { dateTime: at(2, 9) },
      end: { dateTime: at(2, 9, 30) },
    })
    const taken = await book(at(2, 9), {}, 409)
    expect(taken.error.message).toMatch(/That time was just taken/)
    // And the same slot twice: the second is refused.
    await book(at(2, 10))
    await book(at(2, 10), {}, 409, '203.0.113.2')
    // Not a slot at all (off the half hour, or outside hours).
    await book(at(2, 10, 15), {}, 409, '203.0.113.3')
    await book(at(5, 10), {}, 409, '203.0.113.3')
  })

  it('S5: at most 5 bookings per IP per hour and 20 per link per day', async () => {
    await makeLink()
    for (let i = 0; i < 5; i++) await book(at(0, 9 + i), {}, 200, '198.51.100.7')
    const limited = await book(at(0, 15), {}, 429, '198.51.100.7')
    expect(limited.error.message).toMatch(/Too many bookings/)
    for (let i = 0; i < 15; i++) {
      await book(at(1 + Math.floor(i / 8), 9 + (i % 8)), {}, 200, `192.0.2.${i}`)
    }
    const full = await book(at(3, 9), {}, 429, '192.0.2.200')
    expect(full.error.message).toMatch(/too many bookings today/)
  })

  it('keeps the daily cap with this link’s bookings', async () => {
    await makeLink({ dailyCap: 1 })
    await book(at(0, 9))
    const starts = (await page()).slots.map((s: { start: string }) => s.start)
    expect(starts.some((s: string) => s.startsWith(at(0, 0).slice(0, 10)))).toBe(false)
    expect(starts).toContain(at(1, 9))
  })

  it('bad robot checks and taken slots never use up the link’s day', async () => {
    await makeLink()
    for (let i = 0; i < 25; i++) {
      await book(at(0, 9), { token: 'forged' }, 403, `192.0.2.${i}`)
    }
    await book(at(0, 9), {}, 200, '192.0.2.100')
    for (let i = 0; i < 10; i++) await book(at(0, 9), {}, 409, `192.0.2.${110 + i}`)
    await book(at(0, 10), {}, 200, '192.0.2.130')
  })

  it('a calendar Google can’t read fails closed', async () => {
    await makeLink()
    // A synced calendar Google answers with an error for: no times rather than wrong ones.
    services.meetings.calendarSync?.cache.register({
      userId: 'dev:alice@example.test',
      email: ALICE,
      name: 'Alice',
      handle: 'alice',
      isAdmin: false,
    })
    services.meetings.calendarSync?.cache.setCalendars('dev:alice@example.test', ['gone@fake'])
    const down = await api('GET', `/api/book/alice/intro?${week()}`, { as: null, status: 503 })
    expect(down.error.message).toMatch(/isn't available/)
  })

  it('counts the daily cap over the whole first day, even before the notice', async () => {
    await makeLink({ dailyCap: 1 })
    await book(at(0, 9))
    const later = await api('GET', `/api/book/alice/intro?from=${at(0, 12)}&to=${at(1, 0)}`, {
      as: null,
    })
    expect(later.slots).toEqual([])
  })

  it('refuses bad booker details', async () => {
    await makeLink()
    await book(at(0, 9), { name: '  ' }, 400)
    await book(at(0, 9), { email: 'not-an-email' }, 400)
    await book('soon', {}, 400)
    await book(at(0, 9), { answers: ['a', 'b'] }, 400)
    await book(at(0, 9), { email: ALICE }, 400)
    const huge = await app.request('/api/book/alice/intro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: at(0, 9), name: 'x'.repeat(100_000) }),
    })
    expect(huge.status).toBe(413)
  })
})

describe('S8: the robot check', () => {
  const production = {
    NODE_ENV: 'production',
    CLERK_SECRET_KEY: 'sk_live',
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    DEEPGRAM_API_KEY: 'dg',
    ANTHROPIC_API_KEY: 'sk-ant',
  }

  it('production never uses the dev stand-in; without the secret it takes no bookings', () => {
    expect(robotCheckFor(loadConfig(production))).toBeNull()
    expect(robotCheckFor(loadConfig({ ...production, TURNSTILE_SITE_KEY: '0x4AAA' }))).toBeNull()
    expect(
      robotCheckFor(
        loadConfig({ ...production, TURNSTILE_SITE_KEY: '0x4AAA', TURNSTILE_SECRET_KEY: 's' }),
      ),
    ).toBeInstanceOf(Turnstile)
    expect(robotCheckFor(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' }))).toBeInstanceOf(
      FakeRobotCheck,
    )
  })

  it('a server without one says so on the page and refuses to book', async () => {
    await makeLink()
    await services.meetings.sessions.close()
    services.meetings.calendarSync?.cache.close()
    services.index.close()
    // The same data, served as production without the secret would be.
    services = createServices(
      loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'dev',
        HOST_KIND: 'local',
        DATA_DIR: join(root, 'data'),
        LOCAL_HOST_DIR: join(root, 'remotes'),
        ALLOWED_EMAIL_DOMAINS: 'example.test',
        WEBHOOK_SECRET: 'test-webhook-secret',
      }),
      { llm: new FakeLLM(() => ''), robotCheck: null },
    )
    await services.spaces.ensureTeamSpace()
    app = createApp(services)
    await api('GET', '/api/booking') // alice signs in once, so her page can find her
    expect(await api('GET', '/api/booking')).toMatchObject({ canTakeBookings: false })
    expect(await page()).toMatchObject({ robotCheck: null, canTakeBookings: false })
    const refused = await book(at(0, 9), {}, 503)
    expect(refused.error.message).toMatch(/can't take bookings yet/)
  })
})
