import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-mcp-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    WEBHOOK_SECRET: 'test-webhook-secret',
  })
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  await removeDir(root)
})

async function call(
  method: string,
  path: string,
  opts: { as?: string; token?: string; json?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

async function createToken(
  as: string,
  name = 'Claude Code',
): Promise<{ id: string; token: string }> {
  const res = await call('POST', '/api/tokens', { as, json: { name } })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; token: string }
}

/** A real MCP client whose HTTP goes straight into the Hono app. */
async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
    requestInit: { headers },
    fetch: async (input, init) => app.request(new Request(input, init)),
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  const text = first?.type === 'text' ? first.text : ''
  return { isError: result.isError === true, text, value: result.isError ? null : JSON.parse(text) }
}

async function put(as: string, space: string, path: string, content: string) {
  const res = await call('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })
  expect(res.status, await res.clone().text()).toBe(200)
}

describe('access tokens', () => {
  it('creates, lists without the secret, authenticates the API, and revokes', async () => {
    const created = await createToken(ALICE)
    expect(created.token).toMatch(/^hth_[A-Za-z0-9_-]{43}$/)
    expect(created).toMatchObject({ name: 'Claude Code', hint: created.token.slice(-4) })

    const listed = await (await call('GET', '/api/tokens', { as: ALICE })).json()
    expect(listed).toEqual([
      {
        id: created.id,
        name: 'Claude Code',
        hint: created.token.slice(-4),
        createdAt: expect.any(String),
        lastUsedAt: null,
      },
    ])
    expect(JSON.stringify(listed)).not.toContain(created.token)

    const me = await call('GET', '/api/me', { token: created.token })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { principal: { email: string } }).principal.email).toBe(ALICE)

    const afterUse = (await (await call('GET', '/api/tokens', { as: ALICE })).json()) as Array<{
      lastUsedAt: string | null
    }>
    expect(afterUse[0]?.lastUsedAt).toEqual(expect.any(String))

    expect((await call('DELETE', `/api/tokens/${created.id}`, { as: ALICE })).status).toBe(204)
    expect((await call('GET', '/api/me', { token: created.token })).status).toBe(401)
    expect(await (await call('GET', '/api/tokens', { as: ALICE })).json()).toEqual([])
  })

  it('stores only a hash on disk', async () => {
    const { token } = await createToken(ALICE)
    const { readFile } = await import('node:fs/promises')
    const file = await readFile(join(root, 'data', 'tokens', 'tokens.json'), 'utf8')
    expect(file).not.toContain(token)
    expect(file).toContain(ALICE)
  })

  it('refuses unknown tokens, and a token cannot manage tokens', async () => {
    expect((await call('GET', '/api/me', { token: 'hth_not-a-real-token' })).status).toBe(401)
    const { token } = await createToken(ALICE)
    expect((await call('GET', '/api/tokens', { token })).status).toBe(403)
    expect((await call('POST', '/api/tokens', { token, json: { name: 'more' } })).status).toBe(403)
  })

  it("can't revoke another member's token, and validates names", async () => {
    const alices = await createToken(ALICE)
    expect((await call('DELETE', `/api/tokens/${alices.id}`, { as: BOB })).status).toBe(404)
    expect((await call('GET', '/api/me', { token: alices.token })).status).toBe(200)
    expect((await call('POST', '/api/tokens', { as: ALICE, json: { name: '  ' } })).status).toBe(
      400,
    )
    expect(
      (await call('POST', '/api/tokens', { as: ALICE, json: { name: 'x'.repeat(81) } })).status,
    ).toBe(400)
  })

  it('caps tokens at 20 per member', async () => {
    for (let i = 0; i < 20; i++) await createToken(ALICE, `t${i}`)
    const res = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'one more' } })
    expect(res.status).toBe(400)
    await createToken(BOB)
  })

  it('can’t subscribe or unsubscribe push reminders, which would outlive a revoke', async () => {
    const { token } = await createToken(ALICE)
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p', auth: 'a' },
    }
    const sub = await call('POST', '/api/meetings/reminders', { token, json: { subscription } })
    expect(sub.status).toBe(403)
    const unsub = await call('DELETE', '/api/meetings/reminders', {
      token,
      json: { endpoint: subscription.endpoint },
    })
    expect(unsub.status).toBe(403)
  })

  it('doesn’t open WebSockets: the handshake refuses a token', async () => {
    const { token } = await createToken(ALICE)
    const { principalFromAuthMessage } = await import('../../src/sync/handshake.js')
    const asToken = JSON.stringify({ type: 'auth', token })
    expect(
      await principalFromAuthMessage(services.auth, 'http://hearth.test/ws', asToken),
    ).toBeNull()
    const asDev = JSON.stringify({ type: 'auth', devUser: ALICE })
    expect(
      (await principalFromAuthMessage(services.auth, 'http://hearth.test/ws', asDev))?.email,
    ).toBe(ALICE)
  })

  it('marks a REST save made with a token in the commit', async () => {
    const { token } = await createToken(ALICE, 'script')
    const res = await call('PUT', '/api/spaces/team/file', {
      token,
      json: { path: 'docs/by-script.md', content: '# By script\n' },
    })
    expect(res.status).toBe(200)
    const log = await runGit(join(root, 'data', 'repos', 'team'), [
      'log',
      '-1',
      '--format=%an <%ae>%n%B',
    ])
    expect(log).toContain(`Alice <${ALICE}>`)
    expect(log).toContain('Hearth-Via: api (token "script")')
  })
})

describe('the /mcp endpoint', () => {
  it('is 401 without a session or token, and 405 on GET', async () => {
    const res = await call('POST', '/mcp', {
      json: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    })
    const bad = await call('POST', '/mcp', { token: 'hth_nope', json: {} })
    expect(bad.status).toBe(401)
    const { token } = await createToken(ALICE)
    expect((await call('GET', '/mcp', { token })).status).toBe(405)
  })

  it('lists the tools to a real client connected with a token', async () => {
    const { token } = await createToken(ALICE)
    const client = await connect({ authorization: `Bearer ${token}` })
    expect(client.getServerVersion()?.name).toBe('hotsauce')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_note',
      'add_task',
      'ask_meetings',
      'complete_task',
      'create_table',
      'delete_file',
      'file_history',
      'find_person',
      'get_agent_brief',
      'get_brand',
      'get_checkin',
      'get_clip',
      'get_drive_file',
      'get_event',
      'get_link',
      'get_meeting',
      'get_page',
      'get_person',
      'list_boards',
      'list_checkins',
      'list_clips',
      'list_drive_files',
      'list_events',
      'list_files',
      'list_links',
      'list_meetings',
      'list_notes',
      'list_pages',
      'list_spaces',
      'list_tables',
      'list_tasks',
      'move_file',
      'publish_page',
      'read_board',
      'read_file',
      'read_table',
      'restore_file',
      'save_link',
      'search',
      'share_link',
      'update_note',
      'update_table',
      'update_task',
      'write_file',
    ])
    await client.close()
  })

  it('stops working once the token is revoked', async () => {
    const { id, token } = await createToken(ALICE)
    const client = await connect({ authorization: `Bearer ${token}` })
    await call('DELETE', `/api/tokens/${id}`, { as: ALICE })
    await expect(client.listTools()).rejects.toThrow()
  })
})

describe('the synced calendar window', () => {
  it('list_events refuses a range Hearth holds no copy of, rather than answering free', async () => {
    expect(services.meetings.calendarSync).not.toBeNull()
    const { token } = await createToken(ALICE)
    const client = await connect({ authorization: `Bearer ${token}` })
    const day = 24 * 60 * 60 * 1000
    const far = await tool(client, 'list_events', {
      from: new Date(Date.now() + 20 * day).toISOString(),
      to: new Date(Date.now() + 30 * day).toISOString(),
    })
    expect(far.text).toMatch(/^bad_request: .*30 days ago to 15 days ahead/)
    const near = await tool(client, 'list_events')
    expect(near.isError, near.text).toBe(false)
    await client.close()
  })
})

describe('MCP tools', () => {
  let alice: Client

  beforeEach(async () => {
    const { token } = await createToken(ALICE)
    alice = await connect({ authorization: `Bearer ${token}` })
    // Bob signs in once, so his personal space exists.
    await put(BOB, 'bob', 'docs/bob-private.md', '# Bob private plans\n\nZanzibar expansion.\n')
  })

  afterEach(async () => {
    await alice.close()
  })

  it('list_spaces shows team and her own space only', async () => {
    const { value } = await tool(alice, 'list_spaces')
    expect(value.map((s: { name: string }) => s.name).sort()).toEqual(['alice', 'team'])
  })

  it('write_file commits as the member with the MCP trailer; read_file and search find it', async () => {
    const written = await tool(alice, 'write_file', {
      space: 'team',
      path: 'docs/agent-notes.md',
      content: '# Agent notes\n\nThe quokka protocol is ready.\n',
      message: 'docs: add agent notes',
    })
    expect(written.isError, written.text).toBe(false)
    expect(written.value.status).toBe('committed')

    const log = await runGit(join(root, 'data', 'repos', 'team'), [
      'log',
      '-1',
      '--format=%an <%ae>|%cn%n%B',
    ])
    expect(log).toContain(`Alice <${ALICE}>|Hotsauce`)
    expect(log).toContain('docs: add agent notes')
    expect(log).toContain('Hearth-Via: mcp (token "Claude Code")')

    const read = await tool(alice, 'read_file', { space: 'team', path: 'docs/agent-notes.md' })
    expect(read.value.content).toContain('The quokka protocol is ready.')
    expect(read.value.content).toMatch(/^---\nid: /) // Hearth gave it a stable id

    const found = await tool(alice, 'search', { query: 'quokka' })
    expect(found.value).toEqual([
      expect.objectContaining({ space: 'team', path: 'docs/agent-notes.md', title: 'Agent notes' }),
    ])
    expect(found.value[0].snippet).toContain('**quokka**')
  })

  it('write_file with a stale base merges a non-overlapping concurrent edit', async () => {
    await put(ALICE, 'team', 'docs/shared.md', '# Shared\n\nline one\n\nline two\n')
    const read = await tool(alice, 'read_file', { space: 'team', path: 'docs/shared.md' })
    await put(
      BOB,
      'team',
      'docs/shared.md',
      read.value.content.replace('line two', 'line two (Bob)'),
    )
    const merged = await tool(alice, 'write_file', {
      space: 'team',
      path: 'docs/shared.md',
      content: read.value.content.replace('line one', 'line one (agent)'),
      base_blob_oid: read.value.blobOid,
    })
    expect(merged.value.status).toBe('merged')
    expect(merged.value.content).toContain('line one (agent)')
    expect(merged.value.content).toContain('line two (Bob)')
  })

  it('write_file reports an overlapping edit as a conflict tool error', async () => {
    await put(ALICE, 'team', 'docs/clash.md', '# Clash\n\nsame line\n')
    const read = await tool(alice, 'read_file', { space: 'team', path: 'docs/clash.md' })
    await put(BOB, 'team', 'docs/clash.md', read.value.content.replace('same line', 'Bob line'))
    const result = await tool(alice, 'write_file', {
      space: 'team',
      path: 'docs/clash.md',
      content: read.value.content.replace('same line', 'agent line'),
      base_blob_oid: read.value.blobOid,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^conflict: .*refs\/heads\/conflicts\//)
  })

  it('write_file refuses the space ownership record', async () => {
    const result = await tool(alice, 'write_file', {
      space: 'alice',
      path: '.hearth/space.yaml',
      content: 'kind: personal\nowner: bob@example.test\n',
    })
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toMatch(/^forbidden:/)
  })

  it("refuses another member's personal space in every tool that takes a space", async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['search', { query: 'zanzibar', space: 'bob' }],
      ['list_files', { space: 'bob' }],
      ['list_files', { space: 'bob', recursive: true }],
      ['read_file', { space: 'bob', path: 'docs/bob-private.md' }],
      ['write_file', { space: 'bob', path: 'docs/planted.md', content: '# hi\n' }],
      ['list_meetings', { space: 'bob' }],
      ['get_meeting', { space: 'bob', path: 'meetings/x.md' }],
      ['ask_meetings', { question: 'what?', space: 'bob' }],
    ]
    for (const [name, args] of attempts) {
      const result = await tool(alice, name, args)
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(result.text, name).toBe(`forbidden: You don't have access to the space "bob"`)
    }
    // Nothing was planted, and her searches never cover his space.
    await expect(services.git.readFile('bob', 'docs/planted.md')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect((await tool(alice, 'search', { query: 'zanzibar' })).value).toEqual([])
  })

  it('list_files lists one level or recursively', async () => {
    await put(ALICE, 'alice', 'docs/a.md', '# A\n')
    await put(ALICE, 'alice', 'docs/deep/b.md', '# B\n')
    const top = await tool(alice, 'list_files', { space: 'alice', dir: 'docs' })
    expect(top.value.map((e: { path: string }) => e.path)).toEqual([
      'docs/deep',
      'docs/.gitkeep',
      'docs/a.md',
    ])
    const all = await tool(alice, 'list_files', { space: 'alice', dir: 'docs', recursive: true })
    expect(all.value.truncated).toBe(false)
    const slashes = await tool(alice, 'list_files', {
      space: 'alice',
      dir: '/docs/',
      recursive: true,
    })
    expect(slashes.value.files).toHaveLength(3)
    expect(all.value.files.map((e: { path: string }) => e.path).sort()).toEqual([
      'docs/.gitkeep',
      'docs/a.md',
      'docs/deep/b.md',
    ])
  })

  it('read_file refuses binary files and reports missing ones', async () => {
    await services.git.commit('alice', {
      changes: [
        {
          path: 'assets/pixel.png',
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]),
        },
      ],
      author: { name: 'Alice', email: ALICE },
      message: 'add image',
    })
    const binary = await tool(alice, 'read_file', { space: 'alice', path: 'assets/pixel.png' })
    expect(binary.text).toMatch(/^bad_request: .*binary/)
    await put(ALICE, 'alice', 'docs/odd.md', '# Odd\n\nASR wrote \uFFFD here.\n')
    const odd = await tool(alice, 'read_file', { space: 'alice', path: 'docs/odd.md' })
    expect(odd.isError, odd.text).toBe(false)
    expect(odd.value.content).toContain('ASR wrote \uFFFD here.')
    const missing = await tool(alice, 'read_file', { space: 'alice', path: 'docs/nope.md' })
    expect(missing.text).toMatch(/^not_found:/)
  })

  describe('meetings', () => {
    const note = (title: string, date: string, attendees: string[]) =>
      `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees:\n${attendees.map((a) => `  - ${a}`).join('\n')}\ncompanies:\n  - acme.com\ntranscript: ${title.toLowerCase().replace(/\s+/g, '-')}.transcript.md\n---\n# ${title}\n\n- Agreed the pilot budget\n`

    beforeEach(async () => {
      await put(
        ALICE,
        'alice',
        'meetings/2026/11/acme-sync.md',
        note('Acme sync', '2026-11-02T15:00:00Z', ['Pat <pat@acme.com>']),
      )
      await put(
        ALICE,
        'alice',
        'meetings/2026/11/acme-sync.transcript.md',
        '# Transcript\n\n[00:00:05] **Them:** The pilot budget is fine.\n',
      )
      await put(
        ALICE,
        'team',
        'meetings/2026/11/kickoff.md',
        note('Kickoff', '2026-11-05T15:00:00Z', ['Sam <sam@acme.com>']),
      )
      await put(
        BOB,
        'bob',
        'meetings/2026/11/bob-only.md',
        note('Bob only', '2026-11-06T15:00:00Z', ['Pat <pat@acme.com>']),
      )
    })

    it('list_meetings covers her spaces, newest first, with filters', async () => {
      const all = await tool(alice, 'list_meetings')
      expect(all.value.map((m: { title: string }) => m.title)).toEqual(['Kickoff', 'Acme sync'])
      const pat = await tool(alice, 'list_meetings', { person: 'pat@acme.com' })
      expect(pat.value.map((m: { path: string; space: string }) => `${m.space}:${m.path}`)).toEqual(
        ['alice:meetings/2026/11/acme-sync.md'],
      )
      expect(pat.value[0].hasTranscript).toBe(true)
      const before = await tool(alice, 'list_meetings', { to: '2026-11-03' })
      expect(before.value.map((m: { title: string }) => m.title)).toEqual(['Acme sync'])
      const limited = await tool(alice, 'list_meetings', { limit: 1 })
      expect(limited.value).toHaveLength(1)
    })

    it('get_meeting returns the note and its transcript', async () => {
      const { value } = await tool(alice, 'get_meeting', {
        space: 'alice',
        path: 'meetings/2026/11/acme-sync.md',
      })
      expect(value).toMatchObject({
        title: 'Acme sync',
        transcriptPath: 'meetings/2026/11/acme-sync.transcript.md',
        frontmatter: expect.objectContaining({ type: 'meeting' }),
      })
      expect(value.note).toContain('Agreed the pilot budget')
      expect(value.transcript).toContain('The pilot budget is fine.')
      const without = await tool(alice, 'get_meeting', {
        space: 'alice',
        path: 'meetings/2026/11/acme-sync.md',
        include_transcript: false,
      })
      expect(without.value.transcript).toBeNull()
    })

    it('get_meeting refuses a file that is not a meeting note', async () => {
      await put(ALICE, 'alice', 'docs/plain.md', '# Plain\n')
      const result = await tool(alice, 'get_meeting', { space: 'alice', path: 'docs/plain.md' })
      expect(result.text).toMatch(/^bad_request: .*not a meeting note/)
    })

    it('search filters by kind and prefix', async () => {
      const notes = await tool(alice, 'search', { query: 'pilot budget', kind: 'meeting' })
      expect(notes.value.map((h: { path: string }) => h.path).sort()).toEqual([
        'meetings/2026/11/acme-sync.md',
        'meetings/2026/11/kickoff.md',
      ])
      const transcripts = await tool(alice, 'search', { query: 'pilot', kind: ['transcript'] })
      expect(transcripts.value.map((h: { path: string }) => h.path)).toEqual([
        'meetings/2026/11/acme-sync.transcript.md',
      ])
      const none = await tool(alice, 'search', { query: 'pilot', prefix: 'docs/' })
      expect(none.value).toEqual([])
    })

    it('ask_meetings answers with citations from her meetings only', async () => {
      const { value, isError, text } = await tool(alice, 'ask_meetings', {
        question: 'What did we agree about the pilot budget?',
      })
      expect(isError, text).toBe(false)
      expect(typeof value.answer).toBe('string')
      for (const c of value.citations as Array<{ space: string; line: number }>) {
        expect(['alice', 'team']).toContain(c.space)
        expect(c.line).toBeGreaterThan(0)
      }
    })
  })
})
