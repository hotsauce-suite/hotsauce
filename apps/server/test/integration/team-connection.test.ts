// A team-only connection (ARCHITECTURE §8.5, docs/PLAN-team-connection.md): the connection a
// group shares, like a team chat's assistant. It reads the team space only and writes nothing.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { Principal } from '../../src/auth/index.js'
import { loadConfig } from '../../src/config.js'
import { TEAM_ONLY_TOOLS } from '../../src/mcp/server.js'
import type { CalendarEvent, CalendarSource } from '../../src/meetings/calendar/types.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BASE = 'https://office.example.test'
const REDIRECT = 'https://chat.example.test/account/apps/signed-in'

/** Alice's own calendar: a team-only connection must never read it. */
class TestCalendar implements CalendarSource {
  events: CalendarEvent[] = []
  async upcoming(_p: Principal, range: { from: string; to: string }): Promise<CalendarEvent[]> {
    return this.events.filter((e) => e.end > range.from && e.start < range.to)
  }
}

let calendar: TestCalendar
let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-team-connection-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    WEBHOOK_SECRET: 'test-webhook-secret',
    PUBLIC_URL: BASE,
  })
  calendar = new TestCalendar()
  services = createServices(config, { calendar })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  // Alice keeps one doc in the team space and one in her own.
  await put('team', 'docs/launch.md', '# Launch\n\nThe quokka launch is on Friday.\n')
  await put('alice', 'docs/diary.md', '# Diary\n\nMy quokka worries, for nobody else.\n')
})

afterEach(async () => {
  await services.oauth.idle()
  services.index.close()
  await removeDir(root)
})

async function call(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (method === 'POST' && path === '/api/oauth/authorize') headers.origin = BASE
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  }
  return app.request(`${BASE}${path}`, { method, headers, ...(body ? { body } : {}) })
}

async function put(space: string, path: string, content: string) {
  const res = await call('PUT', `/api/spaces/${space}/file`, {
    as: ALICE,
    json: { path, content },
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

/** Register, press Allow with `access` (left out: as an older Allow page did), get tokens. */
async function connectApp(access?: string) {
  const reg = await call('POST', '/oauth/register', {
    json: { redirect_uris: [REDIRECT], client_name: 'Ember' },
  })
  const { client_id } = (await reg.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const allow = await call('POST', '/api/oauth/authorize', {
    as: ALICE,
    json: {
      client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st',
      resource: `${BASE}/mcp`,
      ...(access === undefined ? {} : { access }),
    },
  })
  if (allow.status !== 200)
    return { status: allow.status, client_id, access_token: '', refresh_token: '' }
  const code = new URL(((await allow.json()) as { redirect: string }).redirect).searchParams.get(
    'code',
  )
  const res = await call('POST', '/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: code ?? '',
      code_verifier: verifier,
      client_id,
      redirect_uri: REDIRECT,
    },
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const tokens = (await res.json()) as { access_token: string; refresh_token: string }
  return { status: 200, client_id, ...tokens }
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => app.request(new Request(input, init)),
  })
  const client = new Client({ name: 'ember', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' }
}

describe('choosing team-only on the Allow page (R1, R2, R7)', () => {
  it('keeps the choice on the connection, and Settings lists it', async () => {
    await connectApp('team-read')
    await connectApp()
    const res = await call('GET', '/api/oauth/connections', { as: ALICE })
    const listed = (await res.json()) as Array<{ access: string }>
    expect(listed.map((c) => c.access).sort()).toEqual(['full', 'team-read'])
  })

  it('refuses an access it does not know', async () => {
    expect((await connectApp('everything')).status).toBe(400)
  })

  it('survives a refresh', async () => {
    const first = await connectApp('team-read')
    const res = await call('POST', '/oauth/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: first.client_id,
      },
    })
    const { access_token } = (await res.json()) as { access_token: string }
    const client = await mcpClient(access_token)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('write_file')
    await client.close()
  })
})

describe('a team-only connection on /mcp (R3, R4, R5)', () => {
  let client: Client

  beforeEach(async () => {
    client = await mcpClient((await connectApp('team-read')).access_token)
  })

  afterEach(async () => {
    await client.close()
  })

  it('lists only read tools a whole team may use', async () => {
    const { tools, instructions } = {
      tools: (await client.listTools()).tools,
      instructions: client.getInstructions() ?? '',
    }
    const names = tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(15)
    for (const t of tools) {
      expect(TEAM_ONLY_TOOLS.has(t.name), t.name).toBe(true)
      expect(t.annotations?.readOnlyHint, t.name).toBe(true)
    }
    for (const left of [
      'write_file',
      'add_task',
      'add_note',
      'list_notes',
      'list_events',
      'get_event',
      'get_agent_brief',
      'list_links',
      'list_highlights',
      'save_link',
      'publish_page',
      'share_link',
      'delete_file',
    ]) {
      expect(names, left).not.toContain(left)
    }
    expect(instructions).toContain('team space only')
    expect(names).not.toContain('search_chat')
  })

  it('reads the open chat rooms an admin switched on (PLAN-chat-context R10)', async () => {
    await mkdir(join(root, 'data', 'forms'), { recursive: true })
    await writeFile(
      join(root, 'data', 'forms', 'rooms.json'),
      JSON.stringify({
        rooms: [
          {
            id: 'r1',
            name: 'General',
            url: 'https://chat.example.test/rooms/1/7-key/slack',
            read: true,
          },
        ],
      }),
    )
    // A fresh server answers every request, so the switched-on room shows straight away.
    const tools = (await client.listTools()).tools
    for (const name of ['search_chat', 'read_chat']) {
      const t = tools.find((x) => x.name === name)
      expect(t?.annotations?.readOnlyHint, name).toBe(true)
    }
    const again = await mcpClient((await connectApp('team-read')).access_token)
    expect(again.getInstructions()).toContain('search_chat')
    await again.close()
  })

  it('sees the team space only', async () => {
    const spaces = await tool(client, 'list_spaces')
    expect(JSON.parse(spaces.text).map((s: { name: string }) => s.name)).toEqual(['team'])

    const found = await tool(client, 'search', { query: 'quokka' })
    const paths = JSON.parse(found.text).map((h: { space: string; path: string }) => h.space)
    expect(paths).toEqual(['team'])

    const own = await tool(client, 'read_file', { space: 'alice', path: 'docs/diary.md' })
    expect(own.isError).toBe(true)
    expect(own.text).toMatch(/^forbidden/)

    const team = await tool(client, 'read_file', { space: 'team', path: 'docs/launch.md' })
    expect(team.isError, team.text).toBe(false)
    expect(team.text).toContain('Friday')
  })

  it('cannot call a tool it was not given', async () => {
    const result = await tool(client, 'write_file', {
      space: 'team',
      path: 'docs/x.md',
      content: '# X\n',
    })
    expect(result.isError).toBe(true)
  })
})

describe('a full connection is unchanged (R8)', () => {
  it('still sees the member’s own space and can write', async () => {
    const client = await mcpClient((await connectApp()).access_token)
    const spaces = await tool(client, 'list_spaces')
    expect(
      JSON.parse(spaces.text)
        .map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(['alice', 'team'])
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('write_file')
    await client.close()
  })
})

describe('what belongs to one member stays out (R4, R6)', () => {
  it('is no credential on /api', async () => {
    const { access_token } = await connectApp('team-read')
    const res = await app.request(`${BASE}/api/spaces`, {
      headers: { authorization: `Bearer ${access_token}` },
    })
    expect(res.status).toBe(401)
  })

  it('People never reads the member’s calendar', async () => {
    const soon = Date.now() + 60 * 60 * 1000
    calendar.events = [
      {
        id: 'ev1',
        title: 'Private chat with a recruiter',
        start: new Date(soon).toISOString(),
        end: new Date(soon + 30 * 60 * 1000).toISOString(),
        attendees: [{ email: 'recruiter@elsewhere.test', name: 'Robin Recruiter' }],
      },
    ]
    const full = await mcpClient((await connectApp()).access_token)
    expect((await tool(full, 'find_person', { q: 'recruiter' })).text).toContain('Robin')
    await full.close()
    const shared = await mcpClient((await connectApp('team-read')).access_token)
    const found = await tool(shared, 'find_person', { q: 'recruiter' })
    expect(found.isError, found.text).toBe(false)
    expect(found.text).not.toContain('Robin')
    await shared.close()
  })

  it('Clips shows the team’s finished clips, never the member’s own others', async () => {
    const me = (await (await call('GET', '/api/me', { as: ALICE })).json()) as {
      principal: { userId: string; email: string; name: string }
    }
    const now = new Date().toISOString()
    const owner = me.principal
    services.clips.store.create({
      id: 'clip_failed',
      owner,
      title: 'Failed take',
      mode: 'screen',
      container: 'webm',
      now,
    })
    services.clips.store.update('clip_failed', { status: 'failed' }, now)
    services.clips.store.create({
      id: 'clip_ready',
      owner,
      title: 'Demo for everyone',
      mode: 'screen',
      container: 'webm',
      now,
    })
    services.clips.store.update('clip_ready', { status: 'ready' }, now)

    const full = await mcpClient((await connectApp()).access_token)
    expect((await tool(full, 'list_clips', {})).text).toContain('Failed take')
    await full.close()

    const shared = await mcpClient((await connectApp('team-read')).access_token)
    const listed = await tool(shared, 'list_clips', {})
    expect(listed.text).toContain('Demo for everyone')
    expect(listed.text).not.toContain('Failed take')
    expect(JSON.parse((await tool(shared, 'list_clips', { mine: true })).text)).toEqual([])
    expect((await tool(shared, 'get_clip', { id: 'clip_failed' })).isError).toBe(true)
    await shared.close()
  })
})

describe('a rollback to a release without team-only (R2)', () => {
  it('refuses the connection rather than giving it full access', async () => {
    const { access_token } = await connectApp('team-read')
    // Older releases drop the field they don't know and look tokens up by their plain hash, so
    // a team-only connection's stored hash must never be the plain one.
    expect((await services.oauth.verifyAccess(access_token)).ok).toBe(true)
    const file = join(root, 'data', 'oauth', 'oauth.json')
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      connections: Array<{ accessHash: string }>
    }
    const plain = createHash('sha256').update(access_token).digest('hex')
    expect(state.connections.map((c) => c.accessHash)).not.toContain(plain)
  })
})
