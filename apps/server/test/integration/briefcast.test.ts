import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { Principal } from '../../src/auth/index.js'
import { audioKey, episodePath, FakeSpeaker } from '../../src/briefcast/index.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import {
  type CalendarEvent,
  type CalendarSource,
  FakeLLM,
  type LLMRequest,
  scriptedResponse,
} from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let llm: FakeLLM
let speaker: FakeSpeaker
let respond: (req: LLMRequest) => string | Promise<string>
let events: CalendarEvent[]
let now: Date
let config: ReturnType<typeof loadConfig>

/** A calendar the test fills in; only the asking member's events. */
const calendar: CalendarSource = {
  async upcoming(principal: Principal, range) {
    return events.filter(
      (e) =>
        e.attendees.some((a) => a.email === principal.email) &&
        Date.parse(e.end) > Date.parse(range.from) &&
        Date.parse(e.start) < Date.parse(range.to),
    )
  },
}

beforeEach(async () => {
  root = await makeTempDir('hearth-briefcast-')
  // A Thursday, 10:00 UTC.
  now = new Date('2026-11-12T10:00:00Z')
  events = []
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ORG_NAME: 'Example Co',
    PUBLIC_URL: 'https://hearth.example.test',
    BRIEF_REFRESH_GAP_SECONDS: '0',
    AUDIO_STORE: 'local',
  })
  respond = scriptedResponse
  llm = new FakeLLM((req) => respond(req))
  speaker = new FakeSpeaker()
  services = createServices(config, { llm, speaker, calendar, briefcastNow: () => now })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  await services.briefcasts.close()
  await services.briefs.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

interface Options {
  as?: string | null
  json?: unknown
  headers?: Record<string, string>
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.as !== null) headers['x-hearth-dev-user'] = opts.as ?? ALICE
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  url: string,
  opts: Options & { status?: number } = {},
): Promise<T> {
  const res = await call(method, url, opts)
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

const bare = (space: string) => join(root, 'remotes', `${space}.git`)
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString()
const castCalls = () => llm.calls.filter((c) => c.messages[0]?.content.includes('<calendar_today>'))
const lastPrompt = () => castCalls().at(-1)?.messages[0]?.content ?? ''

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

async function writeMeeting(
  space: string,
  title: string,
  date: string,
  attendees: string[],
  body: string,
  as = ALICE,
) {
  const list = attendees.map((a) => `  - ${a}`).join('\n')
  await api('PUT', `/api/spaces/${space}/file`, {
    as,
    json: {
      path: `meetings/2026/11/${slug(title)}.md`,
      content: `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees:\n${list}\n---\n# ${title}\n\n${body}\n`,
    },
  })
}

async function writeDoc(space: string, path: string, content: string, as: string) {
  await api('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('briefcast', () => {
  it('R1: writes nothing and calls nothing when there is no material', async () => {
    const res = await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    expect(res).toEqual({ status: 'empty', episode: null })
    expect(castCalls()).toHaveLength(0)
    expect(speaker.calls).toHaveLength(0)
    expect(await api('GET', '/api/briefcast')).toMatchObject({
      episodes: [],
      latest: null,
      feedUrl: null,
      voice: true,
    })
  })

  it('R2–R4: is written from calendar, recent meetings, tasks, and spoken', async () => {
    await writeMeeting(
      'alice',
      'Northwind pricing',
      hoursAgo(20),
      [`Alice <${ALICE}>`, 'Priya <priya@northwind.test>'],
      '## Decisions\n\n- Ship tiered pricing in Q1',
    )
    await writeMeeting(
      'alice',
      'Old Priya call',
      hoursAgo(24 * 10),
      [`Alice <${ALICE}>`, 'Priya <priya@northwind.test>'],
      'Priya asked for SOC 2 report',
    )
    await writeMeeting(
      'team',
      'Helios demo',
      hoursAgo(5),
      [`Alice <${ALICE}>`],
      'Demo went well',
      BOB,
    )
    await writeMeeting('team', 'Bob only sync', hoursAgo(5), [`Bob <${BOB}>`], 'Not for Alice', BOB)
    await writeMeeting(
      'bob',
      'Bob private',
      hoursAgo(5),
      [`Bob <${BOB}>`, `Alice <${ALICE}>`],
      'Bob’s own space',
      BOB,
    )
    await api('POST', '/api/tasks', {
      json: { title: 'Send Priya the deck', due: '2026-11-12', priority: 1 },
      status: 201,
    })
    await api('POST', '/api/tasks', {
      json: { title: 'Plan the offsite', due: '2026-11-20' },
      status: 201,
    })
    events = [
      {
        id: 'e1',
        title: 'Priya follow-up',
        start: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
        end: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
        attendees: [
          { email: ALICE, name: 'Alice' },
          { email: 'priya@northwind.test', name: 'Priya' },
        ],
      },
      {
        id: 'e2',
        title: 'Tomorrow thing',
        start: new Date(now.getTime() + 20 * 3_600_000).toISOString(),
        end: new Date(now.getTime() + 21 * 3_600_000).toISOString(),
        attendees: [{ email: ALICE, name: 'Alice' }],
      },
    ]

    const res = await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    expect(res.status).toBe('written')
    expect(res.episode).toMatchObject({
      date: '2026-11-12',
      title: 'Briefcast for Thursday, November 12',
      audio: true,
      voice: 'fake',
      model: 'claude-sonnet-5-5',
      counts: { events: 1, meetings: 2, tasks: 1, docs: 0 },
    })

    const prompt = lastPrompt()
    expect(prompt).toContain('Listener: Alice, at Example Co')
    expect(prompt).toContain('title="Priya follow-up"')
    expect(prompt).toContain('time="12:00 PM"')
    expect(prompt).not.toContain('Tomorrow thing') // after the end of today
    expect(prompt).toContain('Priya asked for SOC 2 report') // prep from an earlier Priya meeting
    expect(prompt).toContain('title="Northwind pricing"')
    expect(prompt).toContain('title="Helios demo"')
    expect(prompt).not.toContain('Bob only sync') // a shared meeting she wasn't at
    expect(prompt).not.toContain('Bob’s own space') // another member's personal space
    expect(prompt).toContain('Send Priya the deck (open, p1, due 2026-11-12)')

    // R3: spoken text has no markdown or links.
    const script: string = res.episode.script
    expect(script).toContain('Good morning.')
    expect(script).not.toMatch(/[#*[\]]|https?:/)
    expect(speaker.calls).toEqual([script])

    // R4: one commit with the script; the audio is stored.
    const log = (await runGit(bare('alice'), ['log', '-1', '--format=%an <%ae>|%s', 'main'])).trim()
    expect(log).toBe(`Alice <${ALICE}>|briefcast: write "Briefcast"`)
    const file = await catFile(bare('alice'), 'main', episodePath('2026-11-12'))
    expect(file).toMatch(/^---\ntype: briefcast\ndate: 2026-11-12\n/)
    expect(file).toContain('# Briefcast for Thursday, November 12')

    const audio = await call('GET', '/api/briefcast/episodes/2026-11-12/audio')
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/mpeg')
    const bytes = new Uint8Array(await audio.arrayBuffer())
    expect(bytes[0]).toBe(0xff)
    const part = await call('GET', '/api/briefcast/episodes/2026-11-12/audio', {
      headers: { range: 'bytes=0-99' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${bytes.length}`)

    // The nightly pass the same day finds nothing new and makes no calls.
    const calls = castCalls().length
    const again = await services.briefcasts.refresh(await principal(ALICE))
    expect(again.status).toBe('unchanged')
    expect(castCalls()).toHaveLength(calls)

    // R6: Bob sees nothing of Alice's.
    expect(await api('GET', '/api/briefcast', { as: BOB })).toMatchObject({
      episodes: [],
      latest: null,
    })
    await api('GET', '/api/briefcast/episodes/2026-11-12', { as: BOB, status: 404 })
    await api('GET', '/api/briefcast/episodes/2026-11-12/audio', { as: BOB, status: 404 })

    const overview = await api('GET', '/api/briefcast')
    expect(overview.episodes).toHaveLength(1)
    expect(overview.latest.date).toBe('2026-11-12')
  })

  it('R2: includes docs other people changed, not the member’s own edits', async () => {
    // Git dates are real time with one-second resolution, so the window (the 24 hours before
    // "now") is placed between two rounds of real commits.
    await writeDoc('team', 'docs/plan.md', '# Plan\n\nFirst draft\n', ALICE)
    await writeDoc('team', 'docs/mine.md', '# Mine\n\nAlice only\n', ALICE)
    await pause(1_100)
    const windowStart = Date.now()
    await pause(1_100)
    await writeDoc('team', 'docs/plan.md', '# Plan\n\nBob rewrote the plan\n', BOB)
    await writeDoc('team', 'docs/mine.md', '# Mine\n\nAlice edited again\n', ALICE)
    now = new Date(windowStart + 86_400_000)

    const res = await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    expect(res.status).toBe('written')
    const prompt = lastPrompt()
    expect(prompt).toContain('title="Plan"')
    expect(prompt).toContain('changed_by="Bob"')
    expect(prompt).toContain('Bob rewrote the plan')
    expect(prompt).not.toContain('title="Mine"')
  })

  it('R7: a private podcast feed that needs its token and can be rotated', async () => {
    await writeMeeting('alice', 'Northwind pricing', hoursAgo(2), [`Alice <${ALICE}>`], 'Decided')
    await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    const { feedUrl } = await api('POST', '/api/briefcast/feed')
    expect(feedUrl).toMatch(
      /^https:\/\/hearth\.example\.test\/api\/briefcast\/feed\/[A-Za-z0-9_-]{32}\.xml$/,
    )
    const path = new URL(feedUrl).pathname

    const feed = await call('GET', path, { as: null })
    expect(feed.status).toBe(200)
    expect(feed.headers.get('content-type')).toContain('application/rss+xml')
    const xml = await feed.text()
    expect(xml).toContain('<rss version="2.0" xmlns:itunes=')
    expect(xml).toContain('<title>Briefcast · Example Co for Alice</title>')
    expect(xml).toContain('<itunes:block>Yes</itunes:block>')
    const enclosure = /<enclosure url="([^"]+)" length="(\d+)" type="audio\/mpeg"\/>/.exec(xml)
    expect(enclosure).not.toBeNull()
    const audio = await call('GET', new URL(enclosure?.[1] ?? '').pathname, { as: null })
    expect(audio.status).toBe(200)
    expect((await audio.arrayBuffer()).byteLength).toBe(Number(enclosure?.[2]))

    // Without a valid token there is nothing; other routes still need a session.
    expect(
      (await call('GET', '/api/briefcast/feed/not-a-real-token-at-all.xml', { as: null })).status,
    ).toBe(404)
    expect((await call('GET', '/api/briefcast', { as: null })).status).toBe(401)

    const rotated = await api('POST', '/api/briefcast/feed')
    expect(rotated.feedUrl).not.toBe(feedUrl)
    expect((await call('GET', path, { as: null })).status).toBe(404)
    expect((await call('GET', new URL(rotated.feedUrl).pathname, { as: null })).status).toBe(200)
    await api('DELETE', '/api/briefcast/feed', { status: 204 })
    expect((await call('GET', new URL(rotated.feedUrl).pathname, { as: null })).status).toBe(404)
    expect((await api('GET', '/api/briefcast')).feedUrl).toBeNull()
  })

  it('R7: the feed works after a restart, before the member has signed in again', async () => {
    await writeMeeting('alice', 'Northwind pricing', hoursAgo(2), [`Alice <${ALICE}>`], 'Decided')
    await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    const { feedUrl } = await api('POST', '/api/briefcast/feed')
    await services.briefcasts.close()
    await services.briefs.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, { llm, speaker, calendar, briefcastNow: () => now })
    app = createApp(services)
    const feed = await call('GET', new URL(feedUrl).pathname, { as: null })
    expect(feed.status).toBe(200)
    expect(await feed.text()).toContain('<enclosure ')
  })

  it('keeps the script when the voice fails', async () => {
    await writeMeeting('alice', 'Northwind pricing', hoursAgo(2), [`Alice <${ALICE}>`], 'Decided')
    speaker.speak = async () => {
      throw new Error('voice down')
    }
    const res = await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    expect(res.status).toBe('written')
    expect(res.episode).toMatchObject({ audio: false, audioExpired: false })
    expect(res.episode.script).toContain('Northwind pricing')
  })

  it('R5: the morning pass writes once per weekday after the hour, and skips weekends', async () => {
    await writeMeeting('alice', 'Northwind pricing', hoursAgo(2), [`Alice <${ALICE}>`], 'Decided')
    await api('GET', '/api/briefcast?tz=America/New_York')

    // Thursday 4:30 AM in New York: before 5 AM, not due.
    now = new Date('2026-11-12T09:30:00Z')
    await services.briefcasts.tick()
    expect(castCalls()).toHaveLength(0)

    // 5:10 AM: written once.
    now = new Date('2026-11-12T10:10:00Z')
    await services.briefcasts.tick()
    expect(castCalls()).toHaveLength(1)
    await services.briefcasts.tick()
    expect(castCalls()).toHaveLength(1)

    // Saturday morning: nothing.
    now = new Date('2026-11-14T11:00:00Z')
    await writeMeeting(
      'alice',
      'Weekend thought',
      new Date(now.getTime() - 3_600_000).toISOString(),
      [`Alice <${ALICE}>`],
      'Hmm',
    )
    await services.briefcasts.tick()
    expect(castCalls()).toHaveLength(1)

    // Monday: written, and "recent" reaches back to Friday.
    now = new Date('2026-11-16T11:00:00Z')
    await services.briefcasts.tick()
    expect(castCalls()).toHaveLength(2)
    expect(lastPrompt()).toContain('since Friday morning')
    expect(lastPrompt()).toContain('Weekend thought')
  })

  it('R8: deletes audio after 30 days and keeps the script', async () => {
    await writeMeeting('alice', 'Northwind pricing', hoursAgo(2), [`Alice <${ALICE}>`], 'Decided')
    await api('POST', '/api/briefcast/refresh', { json: { tz: 'UTC' } })
    const store = services.meetings.audioStore
    const alice = await principal(ALICE)
    expect(await store?.get(audioKey(alice.userId, '2026-11-12'))).not.toBeNull()

    now = new Date('2026-12-11T10:00:00Z')
    expect(await services.briefcasts.cleanup()).toBe(0)
    now = new Date('2026-12-13T10:00:00Z')
    expect(await services.briefcasts.cleanup()).toBe(1)
    expect(await store?.get(audioKey(alice.userId, '2026-11-12'))).toBeNull()
    await api('GET', '/api/briefcast/episodes/2026-11-12/audio', { status: 404 })
    const episode = await api('GET', '/api/briefcast/episodes/2026-11-12')
    expect(episode.script).toContain('Good morning.')
    expect(episode).toMatchObject({ audio: false, audioExpired: true })
  })

  it('refuses a second forced episode within the gap', async () => {
    await services.briefcasts.close()
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data2'),
      LOCAL_HOST_DIR: join(root, 'remotes2'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      BRIEF_REFRESH_GAP_SECONDS: '60',
      AUDIO_STORE: 'local',
    })
    const other = createServices(config, { llm, speaker, calendar, briefcastNow: () => now })
    await other.spaces.ensureTeamSpace()
    const otherApp = createApp(other)
    const post = () =>
      otherApp.request('/api/briefcast/refresh', {
        method: 'POST',
        headers: { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' },
        body: '{}',
      })
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(429)
    await other.briefcasts.close()
    await other.briefs.close()
    other.index.close()
    other.dictation.store.close()
  })
})

async function principal(email: string): Promise<Principal> {
  const found = await services.auth.principalForUser(`dev:${email}`)
  if (found) return found
  throw new Error(`no principal for ${email}`)
}
