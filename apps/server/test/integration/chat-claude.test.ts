import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Claude in chat (docs/PLAN-chat-claude.md R1, R2, R6, R8–R10) through the API and MCP, against a
// fake chat bot API and a fake routine.

const ALICE = 'alice@example.test'
const ADMIN = 'admin@example.test'
const CHAT = 'https://chat.example.test'
const KEY = '7-s3cretbotkey'
const TOKEN = 'sk-ant-oat01-routine-token-abcd'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let fired: string[]
let posted: { url: string; body: string; type: string }[]

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  if (url.startsWith('https://fire.test/')) {
    fired.push(String(init?.body ?? ''))
    return Response.json({ type: 'routine_fire' })
  }
  if (init?.method === 'POST') {
    posted.push({
      url,
      body: String(init.body ?? ''),
      type: new Headers(init.headers).get('content-type') ?? '',
    })
    return new Response(null, { status: 201 })
  }
  return Response.json([])
}

beforeEach(async () => {
  root = await makeTempDir('hotsauce-chat-claude-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://hotsauce.example.test',
    CHAT_URL: CHAT,
    CHAT_READ_INTERVAL_MS: '0',
  })
  fired = []
  posted = []
  services = createServices(config, {
    chatFetch: fakeFetch,
    chatClaudeFireBase: 'https://fire.test/routines',
  })
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

async function call(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; raw?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  const body = opts.raw ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(path, { method, headers, ...(body ? { body } : {}) })
  const text = await res.text()
  return { status: res.status, text, type: res.headers.get('content-type') ?? '' }
}

const delivery = {
  user: { id: 4, name: 'Rajiv' },
  room: { id: 'general', name: 'General', path: `/rooms/general/${KEY}/messages?thread=9` },
  message: {
    id: 11,
    body: { html: '<p>@Claude where is the plan?</p>', plain: 'where is the plan?' },
  },
}

async function setUp() {
  const r = await call('PUT', '/api/chat/claude', {
    as: ADMIN,
    json: { routineId: 'trig_01abc', token: TOKEN },
  })
  expect(r.status, r.text).toBe(200)
  return JSON.parse(r.text) as { webhookUrl: string; ready: boolean; token: { last4: string } }
}

async function mcpFor(email: string) {
  // A member is known once they've made a request.
  await call('GET', '/api/me', { as: email })
  const principal = await services.auth.principalForUser(`dev:${email}`)
  const server = createMcpServer(services, principal!)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
  return client
}

describe('Claude in chat', () => {
  it('R8: only an admin sets it up; the token never comes back', async () => {
    expect((await call('GET', '/api/chat/claude', { as: ALICE })).status).toBe(403)
    expect(
      (await call('PUT', '/api/chat/claude', { as: ALICE, json: { token: TOKEN } })).status,
    ).toBe(403)
    const status = await setUp()
    expect(status.ready).toBe(true)
    expect(status.webhookUrl).toMatch(
      /^https:\/\/hotsauce\.example\.test\/api\/webhooks\/chat-claude\/[\w-]{20,}$/,
    )
    expect(status.token.last4).toBe('abcd')
    const got = await call('GET', '/api/chat/claude', { as: ADMIN })
    expect(got.text).not.toContain(TOKEN)
  })

  it('R1: a wrong secret, or not set up, is a 404 and starts nothing', async () => {
    const before = JSON.parse((await call('GET', '/api/chat/claude', { as: ADMIN })).text)
    const path = new URL(before.webhookUrl).pathname
    expect((await call('POST', path, { json: delivery })).status).toBe(404)
    await setUp()
    expect((await call('POST', `${path}x`, { json: delivery })).status).toBe(404)
    expect((await call('POST', path, { raw: 'not json' })).status).toBe(400)
    expect(fired).toHaveLength(0)
  })

  it('R2, R6, R10: a mention wakes the routine, and reply_in_chat answers in its thread', async () => {
    const { webhookUrl } = await setUp()
    const res = await call('POST', new URL(webhookUrl).pathname, { json: delivery })
    expect(res.status).toBe(200)
    expect(res.type).toMatch(/^text\/plain/)
    expect(res.text).toMatch(/^On it/)
    expect(fired).toHaveLength(1)
    const text = (JSON.parse(fired[0]!) as { text: string }).text
    expect(text).not.toContain(KEY)
    const replyId = /reply_id: (wake_[\w-]+)/.exec(text)?.[1]
    expect(replyId).toBeTruthy()

    const client = await mcpFor(ALICE)
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toContain('reply_in_chat')
    const result = (await client.callTool({
      name: 'reply_in_chat',
      arguments: { reply_id: replyId, text: 'It’s in **docs/plan.md**.' },
    })) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(posted).toEqual([
      {
        url: `${CHAT}/rooms/general/${KEY}/messages?thread=9`,
        body: 'It’s in **docs/plan.md**.',
        type: 'text/markdown; charset=utf-8',
      },
    ])
    const bad = (await client.callTool({
      name: 'reply_in_chat',
      arguments: { reply_id: 'wake_nope', text: 'x' },
    })) as CallToolResult
    expect(bad.isError).toBe(true)
  })

  it('R8: a new address retires the old; turning off retires the tool', async () => {
    const { webhookUrl } = await setUp()
    const next = JSON.parse(
      (await call('POST', '/api/chat/claude/new-address', { as: ADMIN })).text,
    )
    expect(next.webhookUrl).not.toBe(webhookUrl)
    expect((await call('POST', new URL(webhookUrl).pathname, { json: delivery })).status).toBe(404)
    const off = JSON.parse((await call('DELETE', '/api/chat/claude', { as: ADMIN })).text)
    expect(off.ready).toBe(false)
    expect(off.token.set).toBe(false)
    const client = await mcpFor(ALICE)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('reply_in_chat')
  })
})
