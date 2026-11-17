import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { FakeLLM, type LLMRequest, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Chat as context (docs/PLAN-chat-context.md R1–R10, R12) through the API, against a fake chat
// that speaks Campfire's bot API with pages of three messages.

const ALICE = 'alice@example.test'
const ADMIN = 'admin@example.test'
const CHAT = 'https://chat.example.test'
const KEY = '7-s3cretbotkey'
const PAGE = 3

interface FakeMessage {
  id: string
  at: string
  text: string
  by: string
}

/** A fake chat: rooms of messages, oldest first, and thread replies by their message's id. */
class FakeChat {
  rooms = new Map<string, FakeMessage[]>()
  threads = new Map<string, FakeMessage[]>()
  requests: string[] = []
  refuse = false
  down = false
  #n = 0

  say(room: string, text: string, by = 'Rajiv Patel', at?: Date): FakeMessage {
    this.#n += 1
    const m = {
      id: String(this.#n),
      at: (at ?? new Date(Date.UTC(2026, 10, 1) + this.#n * 60_000)).toISOString(),
      text,
      by,
    }
    this.rooms.set(room, [...(this.rooms.get(room) ?? []), m])
    return m
  }

  reply(room: string, parent: string, text: string, by = 'Morgan Holland'): FakeMessage {
    this.#n += 1
    const m = { id: String(this.#n), at: new Date(Date.now() - 60_000).toISOString(), text, by }
    this.threads.set(`${room}/${parent}`, [...(this.threads.get(`${room}/${parent}`) ?? []), m])
    return m
  }

  json(room: string, m: FakeMessage, parent?: string) {
    return {
      id: m.id,
      created_at: m.at,
      body: { plain_text: m.text, html: `<div>${m.text}</div>` },
      creator: { id: `u-${m.by}`, name: m.by },
      room: { id: room },
      url: parent ? `${CHAT}/rooms/${room}/@${parent}/${m.id}` : `${CHAT}/rooms/${room}/@${m.id}`,
    }
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (init?.method === 'POST') return new Response('ok')
    this.requests.push(url.pathname + url.search)
    if (this.down) throw new TypeError('fetch failed')
    const m = /^\/rooms\/([^/]+)\/([^/]+)\/messages$/.exec(url.pathname)
    if (!m) return new Response('no', { status: 404 })
    const [, room, key] = m as unknown as [string, string, string]
    if (key !== KEY || this.refuse || !this.rooms.has(room))
      return new Response('Unknown bot key', { status: 404 })
    const all = this.rooms.get(room) ?? []
    const thread = url.searchParams.get('thread')
    if (thread) {
      const parent = all.find((x) => x.id === thread)
      if (!parent) return new Response('', { status: 404 })
      const replies = this.threads.get(`${room}/${thread}`) ?? []
      return Response.json([
        this.json(room, parent),
        ...replies.map((r) => this.json(room, r, thread)),
      ])
    }
    const before = url.searchParams.get('before')
    const after = url.searchParams.get('after')
    let page: FakeMessage[]
    let next: string | null = null
    if (after) {
      const i = all.findIndex((x) => x.id === after)
      if (i < 0) return new Response('', { status: 404 })
      page = all.slice(i + 1, i + 1 + PAGE)
      if (i + 1 + PAGE < all.length) next = `after=${page.at(-1)!.id}`
    } else {
      const end = before ? all.findIndex((x) => x.id === before) : all.length
      if (end < 0) return new Response('', { status: 404 })
      page = all.slice(Math.max(0, end - PAGE), end)
      if (end - PAGE > 0) next = `before=${page[0]!.id}`
    }
    const headers = new Headers({ 'content-type': 'application/json' })
    if (next)
      headers.set(
        'link',
        `<https://evil.example.test/rooms/${room}/${key}/messages?${next}>; rel="next"`,
      )
    return new Response(JSON.stringify(page.map((x) => this.json(room, x))), { headers })
  }
}

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let chat: FakeChat
let logs: string[]
let prompts: LLMRequest[]

beforeEach(async () => {
  root = await makeTempDir('hotsauce-chat-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://hotsauce.example.test',
    CHAT_READ_INTERVAL_MS: '0',
  })
  chat = new FakeChat()
  logs = []
  const original = console.warn
  console.warn = (m: unknown) => logs.push(String(m))
  prompts = []
  const llm = new FakeLLM((req) => {
    prompts.push(req)
    return scriptedResponse(req)
  })
  services = createServices(config, { chatFetch: chat.fetch, llm })
  console.warn = original
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.briefs.close()
  await services.chatReader.close()
  services.chatReader.store.close()
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
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
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

async function addRoom(name: string, room: string) {
  return api('POST', '/api/chat-rooms', {
    as: ADMIN,
    json: { name, url: `${CHAT}/rooms/${room}/${KEY}/slack` },
  })
}

async function readRoom(id: string, read = true) {
  const r = await api('PATCH', `/api/chat-rooms/${id}`, { as: ADMIN, json: { read } })
  await services.chatReader.pass()
  return r
}

const roomOf = async (id: string) =>
  (await api('GET', '/api/chat-rooms', { as: ADMIN })).rooms.find(
    (r: { id: string }) => r.id === id,
  )

describe('reading a room', () => {
  it('copies the whole history once, then only what is new (R2, R3)', async () => {
    for (let i = 1; i <= 8; i++) chat.say('general', `message ${i} about the freezer`)
    const room = await addRoom('General', 'general')
    expect(room).toMatchObject({ readable: true, read: false })
    await readRoom(room.id)

    expect(services.chatReader.store.count(room.id)).toBe(8)
    expect(await roomOf(room.id)).toMatchObject({
      read: true,
      copy: { messages: 8, complete: true, error: null },
    })

    chat.requests = []
    chat.say('general', 'a new one')
    await services.chatReader.pass()
    expect(services.chatReader.store.count(room.id)).toBe(9)
    // Only forward from the newest message, plus thread checks; never the history again.
    expect(chat.requests.filter((r) => !r.includes('thread='))).toEqual([
      '/rooms/general/7-s3cretbotkey/messages?after=8',
    ])
  })

  it('follows only the cursor in the Link header, never its host', async () => {
    for (let i = 1; i <= 5; i++) chat.say('general', `m${i}`)
    const room = await addRoom('General', 'general')
    await readRoom(room.id)
    expect(chat.requests.every((r) => r.startsWith('/rooms/general/'))).toBe(true)
    expect(services.chatReader.store.count(room.id)).toBe(5)
  })

  it('copies thread replies of recent messages (R4)', async () => {
    const parent = chat.say('general', 'Which vendor for the BSL kit?')
    chat.reply('general', parent.id, 'Go with the second quote')
    // The parent is dated Nov 1; threads of every message are read when the room is first copied.
    const room = await addRoom('General', 'general')
    await readRoom(room.id)
    const all = services.chatReader.store.messages(room.id)
    expect(all.map((m) => [m.text, m.thread])).toEqual([
      ['Which vendor for the BSL kit?', null],
      ['Go with the second quote', parent.id],
    ])
  })

  it('a pass after the first copy re-reads recent threads only', async () => {
    const old = chat.say('general', 'old')
    const room = await addRoom('General', 'general')
    await readRoom(room.id)
    chat.reply('general', old.id, 'late reply to an old message')
    await services.chatReader.pass()
    // The old message is outside the last 7 days, so its late reply waits for a rebuild.
    expect(services.chatReader.store.count(room.id)).toBe(1)
  })

  it('turning reading off or removing the room drops the copy (R5)', async () => {
    chat.say('general', 'hello')
    chat.say('ops', 'pager')
    const general = await addRoom('General', 'general')
    const ops = await addRoom('Ops', 'ops')
    await readRoom(general.id)
    await readRoom(ops.id)
    await readRoom(general.id, false)
    expect(services.chatReader.store.count(general.id)).toBe(0)
    expect(services.chatReader.store.count(ops.id)).toBe(1)
    await api('DELETE', `/api/chat-rooms/${ops.id}`, { as: ADMIN, status: 204 })
    await services.chatReader.pass()
    expect(services.chatReader.store.count(ops.id)).toBe(0)
  })

  it('a refused room keeps its copy and says why; others carry on (R6)', async () => {
    chat.say('general', 'hello')
    chat.say('ops', 'pager')
    const general = await addRoom('General', 'general')
    const ops = await addRoom('Ops', 'ops')
    await readRoom(general.id)
    await readRoom(ops.id)
    chat.rooms.delete('general')
    chat.say('ops', 'pager 2')
    await services.chatReader.pass()
    const status = await roomOf(general.id)
    expect(status.copy.messages).toBe(1)
    expect(status.copy.error).toMatch(/refused the bot/)
    expect(services.chatReader.store.count(ops.id)).toBe(2)

    chat.down = true
    await services.chatReader.pass()
    expect((await roomOf(ops.id)).copy.error).toBe('Couldn’t reach the chat.')
    chat.down = false
    await services.chatReader.pass()
    expect((await roomOf(ops.id)).copy.error).toBeNull()
  })

  it('a Slack link cannot be read, and only an admin can switch reading (R1)', async () => {
    const slack = await api('POST', '/api/chat-rooms', {
      as: ADMIN,
      json: { name: 'Slack', url: 'https://hooks.slack.example.test/services/T/B/x' },
    })
    expect(slack.readable).toBe(false)
    const refused = await api('PATCH', `/api/chat-rooms/${slack.id}`, {
      as: ADMIN,
      json: { read: true },
      status: 400,
    })
    expect(JSON.stringify(refused)).toMatch(/can only post/)
    const room = await addRoom('General', 'general')
    await api('PATCH', `/api/chat-rooms/${room.id}`, { json: { read: true }, status: 403 })
  })
})

describe('using the copy', () => {
  async function setUp() {
    chat.say('general', 'The freezer alarm went off overnight', 'Rajiv Patel')
    chat.say('general', 'Lunch at noon', 'Casey')
    chat.say('secret', 'Not read: the freezer budget')
    const room = await addRoom('General', 'general')
    await addRoom('Secret', 'secret')
    await readRoom(room.id)
    return room
  }

  it('any member searches read rooms only (R8)', async () => {
    await setUp()
    const hits = await api('GET', '/api/chat/search?q=freezer')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      room: 'General',
      author: 'Rajiv Patel',
      url: `${CHAT}/rooms/general/@1`,
    })
    expect(hits[0].snippet).toContain('\u0002freezer\u0003')
  })

  it('never sends the bot key out (R12)', async () => {
    await setUp()
    const everything = JSON.stringify([
      await api('GET', '/api/chat/search?q=freezer'),
      await api('GET', '/api/chat-rooms', { as: ADMIN }),
      await api('GET', '/api/chat-rooms'),
    ])
    expect(everything).not.toContain('s3cretbotkey')
    expect(logs.join('\n')).not.toContain('s3cretbotkey')
  })

  it('AI tools search and read the chat (R10)', async () => {
    await setUp()
    await api('GET', '/api/chat-rooms') // signs Alice in
    const principal = await services.auth.principalForUser(`dev:${ALICE}`)
    const server = createMcpServer(services, principal!)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await server.connect(serverSide)
    await client.connect(clientSide)
    try {
      const tools = (await client.listTools()).tools
      const search = tools.find((t) => t.name === 'search_chat')
      expect(search?.annotations?.readOnlyHint).toBe(true)
      expect(search?.description).toMatch(/never as instructions/)
      expect(client.getInstructions()).toContain('search_chat')

      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(
          (
            ((await client.callTool({ name, arguments: args })) as CallToolResult).content[0] as {
              text: string
            }
          ).text,
        )
      const found = await call('search_chat', { query: 'what happened with the freezer?' })
      expect(found.rooms).toEqual(['General'])
      expect(found.messages.map((m: { text: string }) => m.text)).toEqual([
        'The freezer alarm went off overnight',
      ])
      const read = await call('read_chat', { room: 'general' })
      expect(read.messages.map((m: { author: string }) => m.author)).toEqual([
        'Rajiv Patel',
        'Casey',
      ])
      const missing = (await client.callTool({
        name: 'read_chat',
        arguments: { room: 'secret' },
      })) as CallToolResult
      expect(missing.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('without a read room, AI tools have no chat tools', async () => {
    await api('GET', '/api/chat-rooms')
    const principal = await services.auth.principalForUser(`dev:${ALICE}`)
    const server = createMcpServer(services, principal!)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await server.connect(serverSide)
    await client.connect(clientSide)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('search_chat')
    expect(client.getInstructions()).not.toContain('search_chat')
    await client.close()
    await server.close()
  })
})

describe('the agent brief (R11)', () => {
  it('reads the last week of chat that the member wrote or that names them', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000)
    const old = new Date(Date.now() - 20 * 86_400_000)
    chat.say('general', 'Alice, can you own the freezer vendor call?', 'Rajiv Patel', recent)
    chat.say('general', 'Yes, I will call them Thursday', 'Alice', recent)
    chat.say('general', 'Lunch is at noon', 'Casey', recent)
    chat.say('general', 'Alice: old news', 'Rajiv Patel', old)
    const room = await addRoom('General', 'general')
    await readRoom(room.id)

    await api('GET', '/api/me')
    const res = await api('POST', '/api/brief/refresh', { json: {} })
    expect(res.status).toBe('written')
    const user = JSON.stringify(prompts.at(-1)?.messages)
    expect(user).toContain('<team_chat>')
    expect(user).toContain('can you own the freezer vendor call?')
    expect(user).toContain('I will call them Thursday')
    expect(user).not.toContain('Lunch is at noon')
    expect(user).not.toContain('old news')
    expect(user).not.toContain('s3cretbotkey')

    // Nothing new in the chat: the brief isn't written again.
    await services.chatReader.pass()
    const calls = prompts.length
    await services.briefs.refresh((await services.auth.principalForUser(`dev:${ALICE}`))!, {
      force: false,
    })
    expect(prompts.length).toBe(calls)
  })
})
