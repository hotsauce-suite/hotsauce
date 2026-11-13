import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writablePath } from '../../src/api/save.js'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM } from '../../src/meetings/index.js'
import { FakePushSender } from '../../src/meetings/reminders/sender.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Check-ins (docs/PLAN-checkins.md R1–R10; ARCHITECTURE §24) through the API with dev auth, a
// pinned clock, the fake LLM, a fake push sender and a fake chat webhook.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const ADMIN = 'admin@example.test'
const NY = 'America/New_York'
// Monday 16 November 2026; New York is UTC−5, so 9 AM there is 14:00Z.
const MON_8AM = '2026-11-16T13:00:00.000Z'
const MON_9AM = '2026-11-16T14:00:30.000Z'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let posts: Array<{ url: string; body: { text: string } }>
let llm: FakeLLM
let summaryText: string
let push: FakePushSender
let now: Date

beforeEach(async () => {
  root = await makeTempDir('hearth-checkins-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://hearth.example.test',
  })
  posts = []
  now = new Date(MON_8AM)
  summaryText = 'Alice is shipping the report; Bob is stuck on lab access.'
  llm = new FakeLLM(() => summaryText)
  push = new FakePushSender()
  services = createServices(config, {
    llm,
    pushSender: push,
    checkinsNow: () => now,
    chatFetch: async (input, init) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response('ok')
    },
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  // Everyone signs in once, in New York, so each has a personal space and a known zone.
  for (const who of [ALICE, BOB, ADMIN]) await api('GET', `/api/checkins?tz=${NY}`, { as: who })
})

afterEach(async () => {
  await services.checkinScheduler.close()
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, path: string, opts: { as?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; status?: number } = {},
): Promise<T> {
  const res = await call(method, path, opts)
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

const WEEKLY = {
  title: 'What will you get done this week?',
  days: ['mon'],
  time: '09:00',
  room: null as string | null,
  skip: [ADMIN],
  paused: false,
}

async function create(input: Partial<typeof WEEKLY> = {}) {
  return api('POST', `/api/checkins?tz=${NY}`, { as: ADMIN, json: { ...WEEKLY, ...input } })
}

async function addRoom(): Promise<string> {
  const room = await services.chatRooms.add('Team', 'https://chat.example.test/hooks/abcd/slack')
  posts = []
  return room.id
}

async function teamLog(): Promise<string> {
  const dir = join(root, 'data', 'repos', 'team')
  return runGit(dir, ['log', '--format=%an <%ae>|%s'])
}

describe('setting up (R1–R3)', () => {
  it('an admin creates a check-in as a team file; members and tokens can’t', async () => {
    const made = await create()
    expect(made).toMatchObject({
      title: WEEKLY.title,
      schedule: 'Mondays at 9 AM',
      tz: NY,
      canManage: true,
      asked: [
        { email: ALICE, name: expect.any(String) },
        { email: BOB, name: expect.any(String) },
      ],
    })
    expect(await teamLog()).toContain(`checkins: create "${WEEKLY.title}"`)
    await api('POST', '/api/checkins', { as: ALICE, json: WEEKLY, status: 403 })
    const list = await api('GET', '/api/checkins', { as: BOB })
    expect(list).toMatchObject({ canManage: false, checkins: [{ id: made.id }] })
  })

  it('edits, pauses and deletes', async () => {
    const made = await create()
    const saved = await api('PUT', `/api/checkins/${made.id}`, {
      as: ADMIN,
      json: { ...WEEKLY, title: 'Plans?', paused: true, blobOid: made.blobOid },
    })
    expect(saved).toMatchObject({ title: 'Plans?', paused: true })
    // An old version is refused.
    await api('PUT', `/api/checkins/${made.id}`, {
      as: ADMIN,
      json: { ...WEEKLY, blobOid: made.blobOid },
      status: 409,
    })
    await api('DELETE', `/api/checkins/${made.id}`, { as: BOB, status: 403 })
    await api('DELETE', `/api/checkins/${made.id}`, { as: ADMIN, status: 204 })
    await api('GET', `/api/checkins/${made.id}`, { status: 404 })
    expect(await teamLog()).toContain('checkins: delete "Plans?"')
  })

  it('Docs and MCP writes can’t touch checkins/', () => {
    expect(() => writablePath('checkins/01ARZ3NDEKTSV4RRFFQ69G5FAV.md')).toThrow(/Check-ins app/)
    expect(() => writablePath('checkins')).toThrow()
  })
})

describe('answering and replying (R4–R6)', () => {
  it('opens at 9 AM in the member’s zone; answers, edits and refuses empty', async () => {
    const made = await create()
    // 8 AM: nothing asked yet.
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'Hi' }, status: 400 })
    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: '  ' }, status: 400 })
    const first = await api('POST', `/api/checkins/${made.id}/answers`, {
      json: { text: 'Ship the quarterly report.' },
    })
    expect(first).toMatchObject({ date: '2026-11-16', email: ALICE, mine: true, edited: null })
    const again = await api('POST', `/api/checkins/${made.id}/answers`, {
      json: { text: 'Ship the report and book the lab.' },
    })
    expect(again).toMatchObject({ id: first.id, text: 'Ship the report and book the lab.' })
    expect(again.edited).not.toBeNull()

    const view = await api('GET', `/api/checkins/${made.id}`, { as: BOB })
    expect(view.current).toEqual({ date: '2026-11-16', answered: false, answers: 1 })
    expect(view.rounds[0]).toMatchObject({
      date: '2026-11-16',
      answers: [{ email: ALICE, mine: false, text: 'Ship the report and book the lab.' }],
    })
    // Searchable by the team.
    const hits = await api('GET', '/api/search?q=lab&spaces=team', { as: BOB })
    expect(JSON.stringify(hits)).toContain('checkins/')
  })

  it('anyone replies under an answer, in order', async () => {
    const made = await create()
    now = new Date(MON_9AM)
    const answer = await api('POST', `/api/checkins/${made.id}/answers`, {
      json: { text: 'Lab booking' },
    })
    await api('POST', `/api/checkins/${made.id}/answers/${answer.id}/replies`, {
      as: BOB,
      json: { text: 'I can help with that' },
    })
    const after = await api('POST', `/api/checkins/${made.id}/answers/${answer.id}/replies`, {
      json: { text: 'Thanks!' },
    })
    expect(after.replies.map((r: { by: string; text: string }) => [r.by, r.text])).toEqual([
      [BOB, 'I can help with that'],
      [ALICE, 'Thanks!'],
    ])
    await api('POST', `/api/checkins/${made.id}/answers/${answer.id}/replies`, {
      json: { text: '' },
      status: 400,
    })
  })
})

describe('reminders and Today (R7, R8)', () => {
  const subscribe = (as: string, endpoint: string) =>
    api('POST', '/api/meetings/reminders', {
      as,
      json: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } },
      status: 204,
    })

  it('pushes once per round to asked members who haven’t answered', async () => {
    const made = await create()
    await subscribe(ALICE, 'https://fcm.googleapis.com/fcm/send/alice')
    await subscribe(BOB, 'https://fcm.googleapis.com/fcm/send/bob')
    await subscribe(ADMIN, 'https://fcm.googleapis.com/fcm/send/admin')
    await services.checkinScheduler.tick()
    expect(push.sent).toEqual([])

    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { as: BOB, json: { text: 'Done early' } })
    await services.checkinScheduler.tick()
    await services.checkinScheduler.tick()
    expect(push.sent).toEqual([
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/alice',
        payload: expect.objectContaining({ title: WEEKLY.title, url: `/checkins/${made.id}` }),
      },
    ])
  })

  it('Today lists open rounds you haven’t answered', async () => {
    const made = await create()
    expect((await api('GET', '/api/checkins/due')).due).toEqual([])
    now = new Date(MON_9AM)
    expect((await api('GET', '/api/checkins/due')).due).toMatchObject([
      { id: made.id, title: WEEKLY.title, date: '2026-11-16' },
    ])
    expect((await api('GET', '/api/checkins/due', { as: ADMIN })).due).toEqual([])
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'Plan' } })
    expect((await api('GET', '/api/checkins/due')).due).toEqual([])
  })
})

describe('the summary (R10)', () => {
  it('posts once when everyone has answered, never per answer', async () => {
    const room = await addRoom()
    const made = await create({ room })
    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'Report' } })
    await services.checkinScheduler.tick()
    expect(posts).toEqual([])
    await api('POST', `/api/checkins/${made.id}/answers`, {
      as: BOB,
      json: { text: 'Stuck on <@everyone> lab access' },
    })
    await services.checkinScheduler.tick()
    await services.checkinScheduler.tick()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body.text).toContain(summaryText)
    expect(posts[0]?.body.text).toContain(`/checkins/${made.id}?date=2026-11-16`)
    expect(llm.calls.at(-1)?.messages[0]?.content).toContain('‹@everyone›')
    const view = await api('GET', `/api/checkins/${made.id}`)
    expect(view.rounds[0].summary).toMatchObject({ posted: true, missing: [] })
    expect(await teamLog()).toContain('checkins: summarize')
  })

  it('at the deadline posts the plain list naming who is missing; no answers, no post', async () => {
    const room = await addRoom()
    const made = await create({ room })
    await create({ room, title: 'Nobody answers this' })
    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'Report' } })
    summaryText = '' // the model gives nothing back: the plain list goes instead
    now = new Date('2026-11-16T22:01:00.000Z') // 5:01 PM in New York
    await services.checkinScheduler.tick()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body.text).toContain('Report')
    expect(posts[0]?.body.text).toMatch(/Still to answer: \S/)
  })

  it('without a room the summary is still written, not posted', async () => {
    const made = await create()
    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'A' } })
    await api('POST', `/api/checkins/${made.id}/answers`, { as: BOB, json: { text: 'B' } })
    await services.checkinScheduler.tick()
    expect(posts).toEqual([])
    const view = await api('GET', `/api/checkins/${made.id}`)
    expect(view.rounds[0].summary).toMatchObject({ posted: false })
  })
})

describe('readers (R11–R13)', () => {
  async function answered() {
    const made = await create()
    now = new Date(MON_9AM)
    await api('POST', `/api/checkins/${made.id}/answers`, { json: { text: 'Finish the lab SOP' } })
    await api('POST', `/api/checkins/${made.id}/answers`, {
      as: BOB,
      json: { text: 'Blocked on the freezer quote' },
    })
    return made
  }
  const lastPrompt = () => llm.calls.at(-1)?.messages[0]?.content ?? ''

  it('Briefcast reads teammates’ answers, not your own', async () => {
    await answered()
    await api('POST', '/api/briefcast/refresh', { json: { tz: NY } })
    const prompt = lastPrompt()
    expect(prompt).toContain('<team_checkins>')
    expect(prompt).toContain('Blocked on the freezer quote')
    expect(prompt).not.toContain('Finish the lab SOP')
  })

  it('the Agent brief reads your own answers', async () => {
    await answered()
    await api('POST', '/api/brief/refresh', { json: { tz: NY } })
    const prompt = lastPrompt()
    expect(prompt).toContain('<their_checkin_answers>')
    expect(prompt).toContain('Finish the lab SOP')
    expect(prompt).not.toContain('Blocked on the freezer quote')
  })

  it('MCP lists check-ins and reads a round', async () => {
    const made = await answered()
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { 'x-hearth-dev-user': ALICE } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult
      const first = result.content[0]
      return JSON.parse(first?.type === 'text' ? first.text : 'null')
    }
    expect(await call('list_checkins')).toMatchObject([
      {
        id: made.id,
        title: WEEKLY.title,
        appUrl: `https://hearth.example.test/checkins/${made.id}`,
      },
    ])
    const round = await call('get_checkin', { id: made.id, date: '2026-11-16' })
    expect(round.rounds).toHaveLength(1)
    expect(round.rounds[0].answers.map((a: { text: string }) => a.text).sort()).toEqual([
      'Blocked on the freezer quote',
      'Finish the lab SOP',
    ])
    await client.close()
  })
})
