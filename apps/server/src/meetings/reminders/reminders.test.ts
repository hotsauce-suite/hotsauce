import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../../auth/index.js'
import { CalendarCache } from '../calendar/cache.js'
import { FakeGoogle, fakeGoogleToken } from '../calendar/fake-google.js'
import { GoogleCalendarHttp } from '../calendar/google.js'
import { CachedCalendar, CalendarSync } from '../calendar/sync.js'
import type { CalendarEvent, CalendarSource } from '../calendar/types.js'
import { MeetingReminders } from './reminders.js'
import { FakePushSender } from './sender.js'
import { isPushService, ReminderStore } from './store.js'

const ALICE: Principal = {
  userId: 'user_alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
const sub = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
  keys: { p256dh: 'p', auth: 'a' },
})
const NOW = Date.parse('2026-10-27T15:00:00Z')

function event(id: string, startsInMs: number, attendees = 2): CalendarEvent {
  const start = new Date(NOW + startsInMs)
  return {
    id,
    title: `Event ${id}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    attendees: Array.from({ length: attendees }, (_, i) => ({ email: `p${i}@acme.com` })),
  }
}

let dir: string
let store: ReminderStore
let sender: FakePushSender
let events: CalendarEvent[]
let clock: number
const calendar: CalendarSource = {
  upcoming: async (_principal, range) =>
    events.filter((e) => e.start >= range.from && e.start <= range.to),
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hearth-reminders-'))
  store = new ReminderStore(dir)
  sender = new FakePushSender()
  events = []
  clock = NOW
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const reminders = () =>
  new MeetingReminders({ store, calendar, sender, now: () => new Date(clock), log: () => {} })

describe('MeetingReminders', () => {
  it('reminds each browser about a minute before an event with attendees, once', async () => {
    await store.subscribe(ALICE, sub(1))
    await store.subscribe(ALICE, sub(2))
    events = [event('soon', 60_000), event('solo', 60_000, 0), event('later', 10 * 60_000)]

    const r = reminders()
    await r.tick()
    clock += 30_000
    await r.tick()

    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint])
    expect(sender.sent[0]?.payload).toEqual({
      title: 'Take notes for “Event soon”?',
      body: 'It starts in about a minute.',
      url: '/meetings/start?event=soon',
      tag: 'meeting-soon',
    })
  })

  it('forgets a subscription the browser dropped', async () => {
    await store.subscribe(ALICE, sub(1))
    sender.gone.add(sub(1).endpoint)
    events = [event('soon', 45_000)]
    await reminders().tick()
    expect(await new ReminderStore(dir).subscribers()).toEqual([])
  })

  it('tries again next tick when no browser got it, and remembers a sent one across a restart', async () => {
    await store.subscribe(ALICE, sub(1))
    sender.failing.add(sub(1).endpoint)
    events = [event('soon', 75_000)]
    await reminders().tick()
    expect(sender.sent).toEqual([])

    sender.failing.clear()
    clock += 30_000
    await reminders().tick()
    expect(sender.sent).toHaveLength(1)

    // A second process sees what was already sent.
    clock += 30_000
    const restarted = new MeetingReminders({
      store: new ReminderStore(dir),
      calendar,
      sender,
      now: () => new Date(clock),
      log: () => {},
    })
    await restarted.tick()
    expect(sender.sent).toHaveLength(1)
  })

  it('logs a broken calendar once, not on every tick', async () => {
    await store.subscribe(ALICE, sub(1))
    const logged: string[] = []
    const r = new MeetingReminders({
      store,
      calendar: {
        upcoming: async () => {
          throw new Error('Google Calendar is not connected')
        },
      },
      sender,
      now: () => new Date(clock),
      log: (m) => logged.push(m),
    })
    await r.tick()
    await r.tick()
    await r.tick()
    expect(logged).toHaveLength(1)
  })

  it('accepts only https endpoints on a browser push service', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QAbc',
    ]) {
      expect(isPushService(ok)).toBe(true)
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://localhost/push',
      'https://169.254.169.254/latest/meta-data',
      'https://hearth-example.internal:3000/api',
      'https://fcm.googleapis.com.evil.example/abc',
      'not a url',
    ]) {
      expect(isPushService(bad)).toBe(false)
    }
  })

  it('lets a member unsubscribe only their own browser', async () => {
    await store.subscribe(ALICE, sub(1))
    await store.unsubscribe(sub(1).endpoint, 'bob@example.test')
    expect(await store.subscribers()).toHaveLength(1)
    await store.unsubscribe(sub(1).endpoint, ALICE.email)
    expect(await store.subscribers()).toEqual([])
  })
})

describe('MeetingReminders over the synced calendar (§7.8)', () => {
  let google: FakeGoogle
  let cache: CalendarCache
  let synced: CachedCalendar

  beforeEach(() => {
    google = new FakeGoogle({ now: () => clock, seed: false })
    cache = new CalendarCache(':memory:')
    synced = new CachedCalendar(
      new CalendarSync({
        cache,
        google: new GoogleCalendarHttp({ accessToken: fakeGoogleToken, fetch: google.fetch }),
        now: () => clock,
        log: () => {},
      }),
    )
  })
  afterEach(() => cache.close())

  const remindersOver = () =>
    new MeetingReminders({
      store,
      calendar: synced,
      sender,
      now: () => new Date(clock),
      log: () => {},
    })
  const googleEvent = (id: string, startsInMs: number) => {
    const e = event(id, startsInMs)
    return {
      id,
      summary: e.title,
      start: { dateTime: e.start },
      end: { dateTime: e.end },
      attendees: e.attendees,
    }
  }

  it('reminds a meeting moved since the last sync at its new time, never at its old one', async () => {
    await store.subscribe(ALICE, sub(1))
    google.put(ALICE.email, googleEvent('moved', 2 * 60_000))
    await synced.upcoming(ALICE, {
      from: new Date(clock).toISOString(),
      to: new Date(clock + 1).toISOString(),
    })
    // Moved an hour later after the last sync: the cache still has it a minute from now.
    google.move(ALICE.email, 'moved', 60)
    clock += 61_000
    await remindersOver().tick()
    expect(sender.sent).toHaveLength(0)
    clock = NOW + 61 * 60_000
    await remindersOver().tick()
    expect(sender.sent.map((s) => s.payload.tag)).toEqual(['meeting-moved'])
  })

  it('doesn’t remind a meeting cancelled since the last sync', async () => {
    await store.subscribe(ALICE, sub(1))
    google.put(ALICE.email, googleEvent('cancelled', 5 * 60_000))
    await synced.upcoming(ALICE, {
      from: new Date(clock).toISOString(),
      to: new Date(clock + 1).toISOString(),
    })
    google.cancel(ALICE.email, 'cancelled')
    clock += 4 * 60_000
    await remindersOver().tick()
    expect(sender.sent).toHaveLength(0)
  })

  it('reminds a meeting added a minute before it starts, once the last sync is a minute old', async () => {
    await store.subscribe(ALICE, sub(1))
    await synced.upcoming(ALICE, {
      from: new Date(clock).toISOString(),
      to: new Date(clock + 1).toISOString(),
    })
    clock += 61_000
    google.put(ALICE.email, googleEvent('late', 2 * 60_000))
    await remindersOver().tick()
    expect(sender.sent.map((s) => s.payload.tag)).toEqual(['meeting-late'])
  })

  it('still reminds from the cache when Google fails', async () => {
    await store.subscribe(ALICE, sub(1))
    google.put(ALICE.email, googleEvent('kept', 5 * 60_000))
    await synced.upcoming(ALICE, {
      from: new Date(clock).toISOString(),
      to: new Date(clock + 1).toISOString(),
    })
    google.refuse(ALICE.email, 503)
    clock += 4 * 60_000
    await remindersOver().tick()
    expect(sender.sent.map((s) => s.payload.tag)).toEqual(['meeting-kept'])
    expect(cache.status(ALICE.userId).error).toMatch(/503/)
  })
})
