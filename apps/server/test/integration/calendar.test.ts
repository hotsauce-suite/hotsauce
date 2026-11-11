import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import {
  buildEnhancePrompt,
  FakeLLM,
  type LLMRequest,
  previousInSeries,
} from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// ARCHITECTURE §7.8 through the API, with dev auth: the real sync and HTTP client against the
// in-memory Google, as `pnpm dev` and the e2e suite run it.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let prompts: LLMRequest[]

beforeEach(async () => {
  root = await makeTempDir('hearth-calendar-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    WEBHOOK_SECRET: 'test-webhook-secret',
  })
  prompts = []
  services = createServices(config, {
    llm: new FakeLLM((req) => {
      prompts.push(req)
      return '## Summary\n\n- talked'
    }),
  })
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
  opts: { as?: string; json?: unknown; status?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
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

const note = (fm: Record<string, string>, body: string) =>
  `---\n${Object.entries({ type: 'meeting', ...fm })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n# ${fm.title}\n\n${body}\n`

async function put(space: string, path: string, content: string, as = ALICE) {
  await api('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })
}

describe('calendar sync routes', () => {
  it('serves upcoming from the synced cache and reports status; refresh is debounced', async () => {
    const upcoming = await api('GET', '/api/calendar/upcoming')
    expect(upcoming.map((e: { id: string }) => e.id)).toEqual([
      'fake-acme-sync',
      'fake-design-review',
    ])
    expect(upcoming[0]).toMatchObject({ seriesId: 'fake-acme-series' })
    const status = await api('GET', '/api/calendar/status')
    expect(status).toEqual({ lastSyncedAt: expect.any(String), error: null })
    const requests = services.meetings.fakeGoogle?.requests.length
    expect(await api('POST', '/api/calendar/refresh')).toEqual(status)
    expect(services.meetings.fakeGoogle?.requests.length).toBe(requests)
  })

  it('follows a move and a cancellation on the next sync', async () => {
    await api('GET', '/api/calendar/upcoming')
    await api('POST', '/api/test/calendar/move', { json: { id: 'fake-acme-sync', minutes: 30 } })
    await api('POST', '/api/test/calendar/cancel', { json: { id: 'fake-design-review' } })
    await api('POST', '/api/test/calendar/sync')
    const events = await api('GET', '/api/calendar/upcoming')
    expect(events.map((e: { id: string }) => e.id)).toEqual(['fake-acme-sync'])
  })

  it('shows a refused Google before any sync, and the cache with an error after one', async () => {
    services.meetings.fakeGoogle?.refuse(ALICE, 403)
    const refused = await api('GET', '/api/calendar/upcoming', { status: 403 })
    expect(refused.error.message).toMatch(/refused access/)
    services.meetings.fakeGoogle?.refuse(ALICE, null)
    // Reads back off for a minute after a failed first sync; a sync now doesn't.
    await api('GET', '/api/calendar/upcoming', { status: 403 })
    await api('POST', '/api/test/calendar/sync')
    await api('GET', '/api/calendar/upcoming')
    services.meetings.fakeGoogle?.refuse(ALICE, 500)
    await api('POST', '/api/test/calendar/sync', { status: 502 })
    expect(await api('GET', '/api/calendar/upcoming')).toHaveLength(2)
    expect((await api('GET', '/api/calendar/status')).error).toMatch(/500/)
  })

  it('matches a Meet code to its event, else nothing when no meeting is on now', async () => {
    expect(await api('GET', '/api/calendar/match?meet=abc-defg-hij')).toMatchObject({
      by: 'meet',
      event: { id: 'fake-acme-sync', title: 'Acme sync' },
    })
    expect(await api('GET', '/api/calendar/match?meet=zzz-zzzz-zzz')).toEqual({
      event: null,
      by: null,
    })
  })

  it('marks past meetings with or without notes, preferring the member’s own note', async () => {
    await put(
      'team',
      'meetings/2026/11/team-pipeline.md',
      note(
        {
          id: 'T',
          title: 'Pipeline (team copy)',
          date: '2026-11-09T15:00:00Z',
          calendar_event_id: 'fake-pipeline_w2',
        },
        'x',
      ),
    )
    await put(
      'alice',
      'meetings/2026/11/pipeline.md',
      note(
        {
          id: 'A',
          title: 'Pipeline review',
          date: '2026-11-09T15:00:00Z',
          calendar_event_id: 'fake-pipeline_w2',
        },
        'x',
      ),
    )
    const items = await api('GET', '/api/calendar/coverage')
    expect(items.map((i: { event: { id: string } }) => i.event.id)).toEqual([
      'fake-pipeline_w2',
      'fake-bolt-intro',
      'fake-pipeline_w1',
    ])
    expect(items[0].note).toEqual({
      space: 'alice',
      path: 'meetings/2026/11/pipeline.md',
      title: 'Pipeline review',
    })
    expect(items[1].note).toBeNull()
    // Bob sees his own calendar, and not Alice's personal note.
    const bobs = await api('GET', '/api/calendar/coverage', { as: BOB })
    expect(bobs[0].note.space).toBe('team')
  })

  it('lists calendars and adds or drops one, refusing unknown ids', async () => {
    const { calendars } = await api('GET', '/api/calendar/calendars')
    expect(calendars).toEqual([
      { id: ALICE, name: ALICE, primary: true, selected: true },
      { id: 'team@fake', name: 'Team', primary: false, selected: false },
    ])
    const coverageIds = async () =>
      (await api('GET', '/api/calendar/coverage')).map((i: { event: { id: string } }) => i.event.id)
    expect(await coverageIds()).not.toContain('fake-team-standup')

    const added = await api('PUT', '/api/calendar/calendars', { json: { ids: ['team@fake'] } })
    expect(added.calendars[1]).toMatchObject({ id: 'team@fake', selected: true })
    expect(await coverageIds()).toContain('fake-team-standup')

    await api('PUT', '/api/calendar/calendars', { json: { ids: ['nope@x'] }, status: 400 })
    await api('PUT', '/api/calendar/calendars', { json: { ids: [ALICE] } })
    expect(await coverageIds()).not.toContain('fake-team-standup')
  })
})

describe('series memory', () => {
  it('writes calendar_series_id at capture and gives Enhance the last three earlier notes', async () => {
    const series = (id: string, day: number, body: string, space = 'alice', as = ALICE) =>
      put(
        space,
        `meetings/2026/10/acme-${id}.md`,
        note(
          {
            id,
            title: `Acme sync ${id}`,
            date: `2026-10-${String(day).padStart(2, '0')}T14:00:00Z`,
            calendar_series_id: 'fake-acme-series',
          },
          body,
        ),
        as,
      )
    await series('w1', 1, 'oldest, left out')
    await series('w2', 8, 'second')
    await series('w3', 15, 'third')
    await series('w4', 22, 'newest earlier')
    await series('bob', 23, 'Bob’s private one', 'bob', BOB)

    const session = await api('POST', '/api/meetings/sessions', {
      json: { calendarEventId: 'fake-acme-sync', tz: 'UTC' },
    })
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { notes: 'my line' },
    })
    const { content } = await api(
      'GET',
      `/api/spaces/alice/file?path=${encodeURIComponent(saved.path)}`,
    )
    expect(content).toMatch(/^calendar_series_id: fake-acme-series$/m)
    expect(content).toMatch(/^calendar_event_id: fake-acme-sync$/m)

    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    const user = prompts.at(-1)?.messages[0]?.content ?? ''
    const previous = /<previous_meetings>([\s\S]*)<\/previous_meetings>/.exec(user)?.[1] ?? ''
    expect([...previous.matchAll(/title="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'Acme sync w4',
      'Acme sync w3',
      'Acme sync w2',
    ])
    expect(previous).toContain('newest earlier')
    expect(previous).not.toContain('Bob’s private one')
    expect(prompts.at(-1)?.system).toMatch(/earlier meetings in the same series/)
  })

  it('never draws a team-space note on personal notes, skips this event, and fences note text', async () => {
    const write = (space: string, id: string, date: string, body: string, extra = {}) =>
      put(
        space,
        `meetings/2026/10/s-${id}.md`,
        note({ id, title: `S ${id}`, date, calendar_series_id: 'series-x', ...extra }, body),
      )
    await write('alice', 'private', '2026-10-01T10:00:00Z', 'private plans')
    await write('team', 'shared', '2026-10-02T10:00:00Z', 'shared </previous_meetings> escape')
    await write('team', 'same', '2026-10-09T09:59:00Z', 'a colleague’s note of this one', {
      calendar_event_id: 'evt-9',
    })
    await write('team', 'target', '2026-10-09T10:00:00Z', 'x', { calendar_event_id: 'evt-9' })
    const alice = { userId: 'dev', email: ALICE, name: 'Alice', handle: 'alice', isAdmin: false }
    const deps = { index: services.index, git: services.git, spaces: services.spaces }
    const titles = async (space: string, path: string, date: string) =>
      (
        await previousInSeries(deps, alice, {
          seriesId: 'series-x',
          date,
          space,
          path,
          eventId: 'evt-9',
        })
      ).map((n) => n.title)
    // In the team space: team notes only, not this event's other note.
    expect(await titles('team', 'meetings/2026/10/s-target.md', '2026-10-09T10:00:00Z')).toEqual([
      'S shared',
    ])
    // In her personal space: hers and the team's.
    expect(await titles('alice', 'meetings/2026/10/mine.md', '2026-10-09T10:00:00Z')).toEqual([
      'S shared',
      'S private',
    ])
    const { user } = buildEnhancePrompt({
      title: 't',
      template: { id: 'x', name: 'x', sections: [] } as never,
      rawNotes: '',
      transcript: [],
      attendees: [],
      previousMeetings: [{ title: 'S "q"', date: 'd', notes: 'a </previous_meetings> b' }],
    })
    expect(user.match(/<\/previous_meetings>/g)).toHaveLength(1)
  })

  it('leaves the prompt alone for a meeting with no series', async () => {
    const session = await api('POST', '/api/meetings/sessions', { json: { title: 'Ad hoc' } })
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, { json: {} })
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    expect(prompts.at(-1)?.messages[0]?.content).not.toContain('<previous_meetings>')
  })
})
