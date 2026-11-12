import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { Principal } from '../../src/auth/index.js'
import { loadConfig } from '../../src/config.js'
import { HearthError } from '../../src/errors.js'
import type { CalendarEvent, CalendarSource } from '../../src/meetings/calendar/types.js'
import { FakeLLM, type LLMRequest } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import type { TodayView } from '../../src/today/index.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// The Today page (ARCHITECTURE §16, plan T2–T6): one read of the member's day, from the index
// and the calendar cache only.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const DANA = 'dana@acme.com'
const SAM = 'sam@example.test'
const TZ = 'Asia/Kolkata'

/** A calendar the test fills; `fail` makes it refuse as a missing grant does. */
class TestCalendar implements CalendarSource {
  events: CalendarEvent[] = []
  fail: Error | null = null
  async upcoming(_p: Principal, range: { from: string; to: string }): Promise<CalendarEvent[]> {
    if (this.fail) throw this.fail
    return this.events.filter((e) => e.end > range.from && e.start < range.to)
  }
}

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let calendar: TestCalendar
const llmCalls: LLMRequest[] = []

beforeEach(async () => {
  root = await makeTempDir('hearth-today-')
  calendar = new TestCalendar()
  llmCalls.length = 0
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    }),
    {
      calendar,
      llm: new FakeLLM((req) => {
        llmCalls.push(req)
        return '{}'
      }),
    },
  )
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', ALICE)
  await call('GET', '/api/me', BOB)
})

afterEach(async () => {
  vi.restoreAllMocks()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, url: string, as = ALICE, json?: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: {
      'x-hearth-dev-user': as,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(method: string, url: string, as = ALICE, json?: unknown): Promise<T> {
  const res = await call(method, url, as, json)
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBeLessThan(300)
  return (text ? JSON.parse(text) : null) as T
}

/** The member's day in Asia/Kolkata (UTC+5:30, no daylight saving). */
function day(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now)
  const from = new Date(`${date}T00:00:00+05:30`).toISOString()
  const to = new Date(Date.parse(from) + 86_400_000).toISOString()
  return { date, from, to }
}

const today = (as = ALICE) => {
  const d = day()
  return api<TodayView>(
    'GET',
    `/api/today?from=${encodeURIComponent(d.from)}&to=${encodeURIComponent(d.to)}&date=${d.date}`,
    as,
  )
}

const meetingNote = (o: {
  title: string
  date: string
  attendees: string[]
  series?: string
  event?: string
  body: string
}) =>
  [
    '---',
    'type: meeting',
    `title: ${o.title}`,
    `date: ${o.date}`,
    'attendees:',
    ...o.attendees.map((a) => `  - ${a}`),
    ...(o.series ? [`calendar_series_id: ${o.series}`] : []),
    ...(o.event ? [`calendar_event_id: ${o.event}`] : []),
    '---',
    `# ${o.title}`,
    '',
    o.body,
    '',
  ].join('\n')

const write = (space: string, path: string, content: string, as = ALICE) =>
  api('PUT', `/api/spaces/${space}/file`, as, { path, content })

const hour = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('GET /api/today', () => {
  it('T2/T5: meetings with Prep, due tasks, action items, unfiled notes and changed docs', async () => {
    // Inside the member's day whatever the hour the test runs.
    const soon = Date.parse(day().from) + 6 * hour
    calendar.events = [
      {
        id: 'ev-acme',
        title: 'Acme sync',
        start: iso(soon),
        end: iso(soon + hour / 2),
        attendees: [{ email: ALICE }, { email: DANA, name: 'Dana Lee' }],
        seriesId: 'series-acme',
        meetLink: 'https://meet.google.com/abc-defg-hij',
      },
      {
        id: 'ev-sam',
        title: 'Sam 1:1',
        start: iso(soon + 2 * hour),
        end: iso(soon + 3 * hour),
        attendees: [{ email: ALICE }, { email: SAM }],
      },
      {
        id: 'ev-new',
        title: 'Someone new',
        start: iso(soon + 4 * hour),
        end: iso(soon + 5 * hour),
        attendees: [{ email: ALICE }, { email: 'new@else.test' }],
      },
    ]
    // Same series, older: Prep comes from the newer of the two, not the one with more overlap.
    await write(
      'alice',
      'meetings/2026/11/acme-1.md',
      meetingNote({
        title: 'Acme kickoff',
        date: iso(Date.now() - 9 * 24 * hour),
        attendees: [ALICE, DANA],
        series: 'series-acme',
        body: '## Summary\n\n- They want SSO by March.',
      }),
    )
    await write(
      'alice',
      'meetings/2026/11/acme-2.md',
      meetingNote({
        title: 'Acme sync',
        date: iso(Date.now() - 2 * 24 * hour),
        attendees: [ALICE, DANA],
        series: 'series-acme',
        body: '## Summary\n\n- **Pricing** one-pager is due Friday.\n\n## Action items\n\n- [ ] Send the pricing one-pager',
      }),
    )
    // No series: Prep is the latest note sharing two people (Alice and Sam).
    await write(
      'team',
      'meetings/2026/11/sam.md',
      meetingNote({
        title: 'Hiring chat',
        date: iso(Date.now() - 3 * 24 * hour),
        attendees: [ALICE, SAM],
        body: 'Two offers out.',
      }),
    )
    // Bob's personal space: never on Alice's Today.
    await write(
      'bob',
      'meetings/2026/11/secret.md',
      meetingNote({
        title: 'Bob private',
        date: iso(Date.now() - 1 * 24 * hour),
        attendees: [ALICE, SAM, BOB],
        body: 'Private to Bob.',
      }),
      BOB,
    )
    await write('team', 'docs/roadmap.md', '# Roadmap\n\nQ1 plans.\n')
    await write('bob', 'docs/diary.md', '# Diary\n\nMine.\n', BOB)

    const quick = (text: string, as = ALICE) =>
      api('POST', '/api/tasks/quick', as, { text, tz: TZ })
    await quick('Pay the invoice today')
    await quick('File the expenses yesterday')
    await quick('Plan the offsite next month')
    await quick('Bob thing today', BOB)

    await api('POST', '/api/notes', ALICE, { body: 'Idea: a shared glossary' })
    await api('POST', '/api/notes', ALICE, { body: 'Pinned thought', pinned: true })
    await api('POST', '/api/notes', ALICE, { body: 'Labelled', labels: ['Ideas'] })
    // A teammate's note in the team space isn't Alice's to file.
    await api('POST', '/api/notes', BOB, { body: 'Bob team note', space: 'team' })

    const view = await today()
    expect(view.meetings.error).toBeNull()
    expect(
      view.meetings.events.map((e) => [e.title, e.prep?.title ?? null, e.prep?.line ?? null]),
    ).toEqual([
      ['Acme sync', 'Acme sync', 'Pricing one-pager is due Friday.'],
      ['Sam 1:1', 'Hiring chat', 'Two offers out.'],
      ['Someone new', null, null],
    ])
    expect(view.meetings.events[0]?.meetLink).toBe('https://meet.google.com/abc-defg-hij')
    expect(view.tasks.map((t) => t.title).sort()).toEqual(['File the expenses', 'Pay the invoice'])
    // The to-do's line is the file's own (frontmatter counted), as ticking it in Git needs.
    const acme2 = await api('GET', '/api/spaces/alice/file?path=meetings/2026/11/acme-2.md')
    const todoLine =
      (acme2.content as string).split('\n').indexOf('- [ ] Send the pricing one-pager') + 1
    expect(todoLine).toBeGreaterThan(10)
    expect(view.actionItems).toEqual([
      expect.objectContaining({
        path: 'meetings/2026/11/acme-2.md',
        items: [{ line: todoLine, text: 'Send the pricing one-pager' }],
      }),
    ])
    expect(view.actionItems).toEqual(await api('GET', '/api/tasks/from-meetings'))
    expect(view.notes.map((n) => n.body)).toEqual(['Idea: a shared glossary'])
    expect(view.docs.map((d) => `${d.space}:${d.path}`)).toEqual(['team:docs/roadmap.md'])
    expect(view.briefcast).toBeNull()
    expect(JSON.stringify(view)).not.toMatch(/Bob private|Bob thing|Diary/)

    // A note taken for the event is linked from it.
    await write(
      'alice',
      'meetings/2026/11/today.md',
      meetingNote({
        title: 'Sam 1:1',
        date: iso(soon + 2 * hour),
        attendees: [ALICE, SAM],
        event: 'ev-sam',
        body: 'Notes so far.',
      }),
    )
    const again = await today()
    expect(again.meetings.events[1]?.note).toEqual({
      space: 'alice',
      path: 'meetings/2026/11/today.md',
    })
  })

  it('T4: a task completed from Today leaves it', async () => {
    const task = await api('POST', '/api/tasks/quick', ALICE, { text: 'Call Dana today', tz: TZ })
    expect((await today()).tasks.map((t) => t.id)).toEqual([task.id])
    await api('POST', `/api/tasks/alice/${task.id}/complete`, ALICE, { tz: TZ })
    expect((await today()).tasks).toEqual([])
  })

  it('T6: with no calendar grant the meetings card says why and the rest still loads', async () => {
    calendar.fail = new HearthError('forbidden', 'Connect your Google Calendar in Settings.')
    await api('POST', '/api/tasks/quick', ALICE, { text: 'Still here today', tz: TZ })
    const view = await today()
    expect(view.meetings).toEqual({
      events: [],
      error: 'Connect your Google Calendar in Settings.',
    })
    expect(view.tasks.map((t) => t.title)).toEqual(['Still here'])
  })

  it('refuses a range that is not one day', async () => {
    const res = await call(
      'GET',
      '/api/today?from=2026-11-01T00:00:00Z&to=2026-11-09T00:00:00Z&date=2026-11-01',
    )
    expect(res.status).toBe(400)
  })

  it('T3: no Git reads, no model calls, and under 200 ms on 5,000 indexed files', async () => {
    const files = Array.from({ length: 5000 }, (_, i) => {
      const kind = i % 4
      const path =
        kind === 0
          ? `docs/d${i}.md`
          : kind === 1
            ? `meetings/2026/10/m${i}.md`
            : kind === 2
              ? `tasks/t${i}.md`
              : `notes/n${i}.md`
      const content =
        kind === 1
          ? meetingNote({
              title: `M${i}`,
              date: iso(Date.now() - (i + 2) * hour),
              attendees: [ALICE, `p${i % 50}@example.test`, SAM],
              series: `s${i % 30}`,
              body: '- [ ] Follow up',
            })
          : `# File ${i}\n\nSome words about item ${i}.\n`
      return { path, content, blobOid: `oid${i}` }
    })
    services.index.upsertFiles('team', files)
    calendar.events = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      title: `Event ${i}`,
      start: iso(Date.parse(day().from) + i * 1.5 * hour),
      end: iso(Date.parse(day().from) + (i * 1.5 + 1) * hour),
      attendees: [{ email: ALICE }, { email: SAM }],
      seriesId: `s${i}`,
    }))
    const reads = vi.spyOn(services.git, 'readFile')
    await today() // warm
    const started = performance.now()
    const view = await today()
    const elapsed = performance.now() - started
    expect(reads).not.toHaveBeenCalled()
    expect(llmCalls).toEqual([])
    expect(view.meetings.events).toHaveLength(12)
    expect(view.docs.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})
