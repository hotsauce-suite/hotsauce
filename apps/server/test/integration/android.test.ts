import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANDROID_PACKAGE } from '../../src/api/android.js'
import { createApp } from '../../src/app.js'
import type { Principal } from '../../src/auth/index.js'
import { loadConfig } from '../../src/config.js'
import type { CalendarEvent, CalendarSource } from '../../src/meetings/calendar/types.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// The Android app's server side (docs/PLAN-android.md R4–R7): the Chrome shell's trust file, a
// phone's own device token, and the one summary its widgets read.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const TZ = 'Asia/Kolkata'
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
)

class TestCalendar implements CalendarSource {
  events: CalendarEvent[] = []
  async upcoming(_p: Principal, range: { from: string; to: string }): Promise<CalendarEvent[]> {
    return this.events.filter((e) => e.end > range.from && e.start < range.to)
  }
}

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let calendar: TestCalendar

async function setup(env: Record<string, string> = {}) {
  root = await makeTempDir('hotsauce-android-')
  calendar = new TestCalendar()
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      ...env,
    }),
    { calendar },
  )
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
}

beforeEach(() => setup())

afterEach(async () => {
  vi.restoreAllMocks()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

interface Options {
  as?: string
  token?: string
  json?: unknown
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function json<T = any>(res: Response, status = 200): Promise<T> {
  const text = await res.text()
  expect(res.status, text).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

async function connectPhone(as = ALICE): Promise<{ id: string; kind: string; token: string }> {
  const res = await call('POST', '/api/dictation/devices', {
    as,
    json: { name: 'Pixel 9', kind: 'phone' },
  })
  return json(res, 201)
}

function dayQuery(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now)
  const from = new Date(`${date}T00:00:00+05:30`).toISOString()
  const to = new Date(Date.parse(from) + 86_400_000).toISOString()
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${date}`
}

const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('/.well-known/assetlinks.json', () => {
  it('R4: names no app until a fingerprint is known', async () => {
    expect(await json(await call('GET', '/.well-known/assetlinks.json'))).toEqual([])
  })

  it('R4: vouches for the Android app with the configured fingerprints, without signing in', async () => {
    services.index.close()
    services.dictation.store.close()
    await removeDir(root)
    await setup({ ANDROID_CERT_SHA256: `${FINGERPRINT.toLowerCase()}, ${FINGERPRINT}` })
    expect(await json(await call('GET', '/.well-known/assetlinks.json'))).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ])
  })

  it('R4: refuses a malformed fingerprint at start', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', ANDROID_CERT_SHA256: 'AB:CD' }),
    ).toThrow(/ANDROID_CERT_SHA256/)
  })
})

describe('a phone device', () => {
  it('R5: is created from a session, shown once, listed as a phone and revocable', async () => {
    const phone = await connectPhone()
    expect(phone.kind).toBe('phone')
    expect(phone.token).toMatch(/^hpt_/)
    const mac = await json(
      await call('POST', '/api/dictation/devices', { as: ALICE, json: { name: 'Mac' } }),
      201,
    )
    expect(mac.kind).toBe('mac')
    expect(mac.token).toMatch(/^hdt_/)
    const listed = await json(await call('GET', '/api/dictation/devices?kind=all', { as: ALICE }))
    expect(listed.map((d: { kind: string }) => d.kind).sort()).toEqual(['mac', 'phone'])
    expect(JSON.stringify(listed)).not.toContain(phone.token)
    // The plain list stays Macs only, as the web's Mac checks read it.
    const macs = await json(await call('GET', '/api/dictation/devices', { as: ALICE }))
    expect(macs.map((d: { id: string }) => d.id)).toEqual([mac.id])
    const phones = await json(await call('GET', '/api/dictation/devices?kind=phone', { as: ALICE }))
    expect(phones.map((d: { id: string }) => d.id)).toEqual([phone.id])

    await json(await call('DELETE', `/api/dictation/devices/${phone.id}`, { as: ALICE }), 204)
    await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { token: phone.token }), 401)
  })

  it('R6: may read only its widget summary and disconnect itself', async () => {
    const phone = await connectPhone()
    const refused: Array<[string, string]> = [
      ['GET', '/api/today?' + dayQuery()],
      ['GET', '/api/me'],
      ['GET', '/api/tasks'],
      ['GET', '/api/dictation/words'],
      ['GET', '/api/dictation/settings'],
      ['POST', '/api/dictation/transcribe'],
      ['GET', '/api/dictation/devices'],
      ['POST', '/api/dictation/devices'],
      ['GET', '/api/spaces/team/files'],
    ]
    for (const [method, url] of refused) {
      await json(await call(method, url, { token: phone.token }), 401)
    }
    await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { token: phone.token }))
    await json(await call('DELETE', '/api/dictation/devices/self', { token: phone.token }), 204)
    await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { token: phone.token }), 401)
  })

  it('R6: a Mac token cannot read the widgets, and a phone token posing as a Mac is refused', async () => {
    const mac = await json(
      await call('POST', '/api/dictation/devices', { as: ALICE, json: { name: 'Mac' } }),
      201,
    )
    await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { token: mac.token }), 401)
    const phone = await connectPhone()
    // Same secret, Mac prefix: an unknown token, not a phone's.
    const posing = phone.token.replace(/^hpt_/, 'hdt_')
    await json(await call('GET', '/api/dictation/words', { token: posing }), 401)
  })

  it('R6: is refused once its member may no longer use Hotsauce', async () => {
    const phone = await connectPhone()
    vi.spyOn(services.auth, 'principalForUser').mockResolvedValue(null)
    await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { token: phone.token }), 401)
  })
})

describe('GET /api/widgets/today', () => {
  it('R7: the next meeting with its join link, up to 3 tasks due, and no weather without a place', async () => {
    const start = Date.now() + HOUR
    calendar.events = [
      // Already over: not the next one.
      {
        id: 'ev-past',
        title: 'Standup',
        start: iso(Date.now() - 2 * HOUR),
        end: iso(Date.now() - HOUR - 1),
        attendees: [{ email: ALICE }],
      },
      {
        id: 'ev-acme',
        title: 'Acme sync',
        start: iso(start),
        end: iso(start + HOUR / 2),
        attendees: [{ email: ALICE }, { email: 'dana@acme.com', name: 'Dana Lee' }],
        meetLink: 'https://meet.google.com/abc-defg-hij',
      },
    ]
    for (const text of [
      'Pay the invoice today',
      'File expenses today',
      'Call Dana today',
      'Book travel today',
    ]) {
      await json(await call('POST', '/api/tasks/quick', { as: ALICE, json: { text, tz: TZ } }), 201)
    }
    const phone = await connectPhone()
    const summary = await json(
      await call('GET', `/api/widgets/today?${dayQuery()}`, { token: phone.token }),
    )
    const meetingToday = start < Date.parse(dayQueryTo())
    expect(summary.meeting).toEqual(
      meetingToday
        ? {
            id: 'ev-acme',
            title: 'Acme sync',
            start: iso(start),
            end: iso(start + HOUR / 2),
            joinUrl: 'https://meet.google.com/abc-defg-hij',
          }
        : null,
    )
    expect(summary.tasks).toHaveLength(3)
    expect(summary.tasksDue).toBe(4)
    expect(Object.keys(summary.tasks[0]).sort()).toEqual(['due', 'dueAt', 'id', 'space', 'title'])
    expect(summary.weather).toBeNull()
    // Nothing a lifted token shouldn't see: no attendees, notes or docs.
    expect(JSON.stringify(summary)).not.toContain('dana@acme.com')
    expect(summary).not.toHaveProperty('notes')
    expect(summary).not.toHaveProperty('docs')
  })

  it('R7: a weather failure leaves the rest of the summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const phone = await connectPhone()
    const summary = await json(
      await call('GET', `/api/widgets/today?${dayQuery()}&lat=44.26&lon=-72.58`, {
        token: phone.token,
      }),
    )
    expect(summary.weather).toBeNull()
    expect(summary.tasks).toEqual([])
  })

  it('R7: refuses a day that isn’t one day', async () => {
    const phone = await connectPhone()
    await json(
      await call(
        'GET',
        '/api/widgets/today?from=2026-11-25T00:00:00Z&to=2026-11-28T00:00:00Z&date=2026-11-25',
        {
          token: phone.token,
        },
      ),
      400,
    )
  })

  it('R7: a session can read it too, and Bob sees only his own', async () => {
    await json(
      await call('POST', '/api/tasks/quick', {
        as: ALICE,
        json: { text: 'Alice thing today', tz: TZ },
      }),
      201,
    )
    const bob = await json(await call('GET', `/api/widgets/today?${dayQuery()}`, { as: BOB }))
    expect(bob.tasks).toEqual([])
  })
})

function dayQueryTo(): string {
  return decodeURIComponent(/to=([^&]+)/.exec(dayQuery())?.[1] ?? '')
}
