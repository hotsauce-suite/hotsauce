import { join } from 'node:path'
import { notePath } from '@hearth/format'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { Notes, type NoteView } from '../../src/notes/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-notes-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  services = createServices(config, { llm: new FakeLLM(scriptedResponse) })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
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
async function api<T = any>(
  method: string,
  url: string,
  opts: Options & { status?: number } = {},
): Promise<T> {
  const res = await call(method, url, { as: ALICE, ...opts })
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

const bare = (space: string) => join(root, 'remotes', `${space}.git`)
const lastCommit = async (space: string) =>
  (await runGit(bare(space), ['log', '-1', '--format=%an <%ae>|%s', 'main'])).trim()
const readRemote = (space: string, path: string) => catFile(bare(space), 'main', path)
const board = async (as = ALICE, query = '') =>
  (await api<{ notes: NoteView[] }>('GET', `/api/notes${query}`, { as })).notes

async function add(json: Record<string, unknown>, as = ALICE): Promise<NoteView> {
  return api('POST', '/api/notes', { as, json, status: 201 })
}

describe('writes', () => {
  it('creates, edits, pins, archives, trashes, restores and deletes, each a commit by the member', async () => {
    const n = await add({ title: 'Groceries', body: '- [ ] milk\n- [ ] eggs', color: 'yellow' })
    expect(n).toMatchObject({
      space: 'alice',
      path: notePath(n.id),
      title: 'Groceries',
      body: '- [ ] milk\n- [ ] eggs',
      checklist: true,
      color: 'yellow',
      pinned: false,
      createdBy: ALICE,
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: create "Groceries"`)
    const file = await readRemote('alice', n.path)
    expect(file).toContain('type: note\n')
    expect(file.endsWith('\n- [ ] milk\n- [ ] eggs\n')).toBe(true)

    const ticked = await api<NoteView>('PATCH', `/api/notes/alice/${n.id}`, {
      json: { body: '- [x] milk\n- [ ] eggs', baseBlobOid: n.blobOid },
    })
    expect(ticked.body).toBe('- [x] milk\n- [ ] eggs')
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: edit "Groceries"`)
    expect(await readRemote('alice', n.path)).toContain('color: yellow\n')

    await api('PATCH', `/api/notes/alice/${n.id}`, { json: { pinned: true } })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: pin "Groceries"`)
    await api('PATCH', `/api/notes/alice/${n.id}`, { json: { archived: true } })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: archive "Groceries"`)
    expect(await board()).toEqual([])
    expect((await board(ALICE, '?view=archive')).map((x) => x.id)).toEqual([n.id])

    await api('POST', `/api/notes/alice/${n.id}/trash`)
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: trash "Groceries"`)
    expect(await board(ALICE, '?view=archive')).toEqual([])
    const trashed = await board(ALICE, '?view=trash')
    expect(trashed.map((x) => x.id)).toEqual([n.id])
    expect(trashed[0]?.trashed).toEqual(expect.any(String))
    expect(trashed[0]?.pinned).toBe(false)

    await api('POST', `/api/notes/alice/${n.id}/restore`)
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: restore "Groceries"`)
    expect((await board(ALICE, '?view=archive')).map((x) => x.id)).toEqual([n.id])

    await api('DELETE', `/api/notes/alice/${n.id}`, { status: 204 })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: delete "Groceries"`)
    await api('GET', `/api/notes/alice/${n.id}`, { status: 404 })
    const day = new Date().toISOString().slice(0, 10)
    expect(await readRemote('alice', `.trash/${day}/${n.path}`)).toContain('title: Groceries')
  })

  it('names an untitled note by its first words', async () => {
    await add({ body: '- [ ] call the "plumber" about the sink' })
    expect(await lastCommit('alice')).toBe(
      `Alice <${ALICE}>|notes: create "call the 'plumber' about the sink"`,
    )
    await add({})
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: create "Untitled note"`)
  })

  it('refuses to overwrite text someone else changed, but merges other fields', async () => {
    const n = await add({ body: 'v1' })
    const other = await api<NoteView>('PATCH', `/api/notes/alice/${n.id}`, { json: { body: 'v2' } })
    await api('PATCH', `/api/notes/alice/${n.id}`, {
      json: { body: 'mine', baseBlobOid: n.blobOid },
      status: 409,
    })
    const colored = await api<NoteView>('PATCH', `/api/notes/alice/${n.id}`, {
      json: { color: 'green', baseBlobOid: n.blobOid },
    })
    expect(colored).toMatchObject({ body: 'v2', color: 'green' })
    const mine = await api<NoteView>('PATCH', `/api/notes/alice/${n.id}`, {
      json: { body: 'v3', baseBlobOid: other.blobOid },
    })
    expect(mine.body).toBe('v3')
  })

  it('keeps a hand edit to the frontmatter when patching', async () => {
    const n = await add({ title: 'T', body: 'x' })
    const file = await services.git.readFile('alice', n.path)
    await services.git.commit('alice', {
      changes: [
        { path: n.path, content: file.content.replace('type: note', 'type: note # by hand') },
      ],
      author: { name: 'Alice', email: ALICE },
      message: 'hand edit',
    })
    await services.syncer.afterHeadChanged('alice')
    await api('PATCH', `/api/notes/alice/${n.id}`, { json: { labels: ['Home'] } })
    const after = await readRemote('alice', n.path)
    expect(after).toContain('type: note # by hand')
    expect(after).toContain('- Home')
  })

  it('rejects a bad color', async () => {
    await api('POST', '/api/notes', { json: { color: 'chartreuse' }, status: 400 })
  })
})

describe('the board', () => {
  it('puts pinned notes first, then the newest or manual order, and filters by label and words', async () => {
    const a = await add({ title: 'A', labels: ['Work'] })
    const b = await add({ title: 'B' })
    const c = await add({ title: 'C', body: 'zebra crossing', pinned: true })
    expect((await board()).map((n) => n.title)).toEqual(['C', 'B', 'A'])
    await api('PATCH', `/api/notes/alice/${a.id}`, { json: { order: Date.parse(b.created) + 1 } })
    expect((await board()).map((n) => n.title)).toEqual(['C', 'A', 'B'])
    expect((await board(ALICE, '?label=work')).map((n) => n.title)).toEqual(['A'])
    expect((await board(ALICE, '?q=zebra')).map((n) => n.title)).toEqual(['C'])
    expect(await api('GET', '/api/notes/labels')).toEqual([{ name: 'Work', count: 1 }])
    expect(c.pinned).toBe(true)
  })

  it('keeps personal notes from other members and shares team ones', async () => {
    const mine = await add({ title: 'Private' })
    const team = await add({ title: 'For everyone', space: 'team' })
    expect((await board(BOB)).map((n) => n.title)).toEqual(['For everyone'])
    await api('GET', `/api/notes/alice/${mine.id}`, { as: BOB, status: 403 })
    await api('PATCH', `/api/notes/alice/${mine.id}`, {
      as: BOB,
      json: { title: 'x' },
      status: 403,
    })
    expect(team.space).toBe('team')
  })

  it('moves a note to the team space in one commit per space', async () => {
    const n = await add({ title: 'Share me', body: 'hello' })
    const moved = await api<NoteView>('POST', `/api/notes/alice/${n.id}/move`, {
      json: { toSpace: 'team' },
    })
    expect(moved).toMatchObject({ space: 'team', id: n.id, body: 'hello' })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|notes: move "Share me"`)
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: move "Share me"`)
    expect((await board(BOB)).map((x) => x.title)).toEqual(['Share me'])
    await api('GET', `/api/notes/alice/${n.id}`, { status: 404 })
  })

  it('lets only the writer of a team note make it private again', async () => {
    const n = await add({ title: 'Team plan', space: 'team' })
    await api('POST', `/api/notes/team/${n.id}/move`, {
      as: BOB,
      json: { toSpace: 'bob' },
      status: 403,
    })
    const back = await api<NoteView>('POST', `/api/notes/team/${n.id}/move`, {
      json: { toSpace: 'alice' },
    })
    expect(back.space).toBe('alice')
  })

  it('empties notes trashed over 30 days ago when the trash is opened', async () => {
    const n = await add({ title: 'Old' })
    const keep = await add({ title: 'Recent' })
    // A service whose clock is 31 days ago trashes the first one.
    const past = new Notes({
      git: services.git,
      index: services.index,
      spaces: services.spaces,
      syncer: services.syncer,
      now: () => new Date(Date.now() - 31 * 86_400_000),
    })
    const principal = { email: ALICE, name: 'Alice', handle: 'alice' } as Parameters<
      Notes['trash']
    >[0]
    await past.trash(principal, 'alice', n.id)
    await api('POST', `/api/notes/alice/${keep.id}/trash`)
    const trash = await board(ALICE, '?view=trash')
    expect(trash.map((x) => x.title)).toEqual(['Recent'])
    await api('GET', `/api/notes/alice/${n.id}`, { status: 404 })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: empty trash "Old"`)
  })
})

describe('Google Keep import', () => {
  const takeout = [
    {
      ref: 'Groceries.json',
      note: {
        title: 'Groceries',
        listContent: [{ text: 'milk', isChecked: false }],
        color: 'YELLOW',
        isPinned: true,
        labels: [{ name: 'Home' }],
        createdTimestampUsec: 1_700_000_000_000_000,
      },
    },
    { ref: 'Idea.json', note: { textContent: 'A thought', isArchived: true } },
    { ref: 'Gone.json', note: { textContent: 'deleted', isTrashed: true } },
  ]

  it('imports into the personal space in one commit, and only adds new notes the second time', async () => {
    const first = await api('POST', '/api/notes/import/keep', { json: { notes: takeout } })
    expect(first).toEqual({ imported: 2, skipped: 1 })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|notes: import 2 from Google Keep`)
    const [g] = await board()
    expect(g).toMatchObject({
      title: 'Groceries',
      body: '- [ ] milk',
      checklist: true,
      color: 'yellow',
      pinned: true,
      labels: ['Home'],
      created: '2023-11-14T22:13:20Z',
      source: { kind: 'import', from: 'keep', ref: 'Groceries.json' },
    })
    expect((await board(ALICE, '?view=archive')).map((n) => n.body)).toEqual(['A thought'])

    const again = await api('POST', '/api/notes/import/keep', {
      json: { notes: [...takeout, { ref: 'New.json', note: { textContent: 'new one' } }] },
    })
    expect(again).toEqual({ imported: 1, skipped: 3 })

    // Two imports at once still add each note once.
    const twice = [{ ref: 'Twice.json', note: { textContent: 'only once' } }]
    await Promise.all([
      api('POST', '/api/notes/import/keep', { json: { notes: twice } }),
      api('POST', '/api/notes/import/keep', { json: { notes: twice } }),
    ])
    expect((await board()).filter((x) => x.body === 'only once')).toHaveLength(1)
  })

  it('refuses an access token', async () => {
    const res = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'agent' } })
    const { token } = (await res.json()) as { token: string }
    const r = await call('POST', '/api/notes/import/keep', { token, json: { notes: takeout } })
    expect(r.status).toBe(403)
  })
})

describe('MCP tools', () => {
  async function connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { 'x-hearth-dev-user': ALICE } },
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
    return {
      isError: result.isError === true,
      text,
      value: result.isError ? null : JSON.parse(text),
    }
  }

  it('lists, adds and updates notes, and searches them', async () => {
    const client = await connect()
    const added = await tool(client, 'add_note', {
      title: 'Offsite',
      body: '- [ ] book venue',
      color: 'blue',
    })
    expect(added.value).toMatchObject({
      title: 'Offsite',
      checklist: true,
      source: { kind: 'mcp' },
    })
    const log = await runGit(bare('alice'), ['log', '-1', '--format=%an <%ae>|%B', 'main'])
    expect(log).toContain(`Alice <${ALICE}>|notes: create "Offsite"`)
    expect(log).toContain('Hearth-Via: mcp')

    expect((await tool(client, 'list_notes')).value.map((n: NoteView) => n.title)).toEqual([
      'Offsite',
    ])
    const updated = await tool(client, 'update_note', {
      space: 'alice',
      id: added.value.id,
      body: '- [x] book venue',
      pinned: true,
    })
    expect(updated.value).toMatchObject({ body: '- [x] book venue', pinned: true })
    const trashed = await tool(client, 'update_note', {
      space: 'alice',
      id: added.value.id,
      trashed: true,
    })
    expect(trashed.value.trashed).toEqual(expect.any(String))
    expect((await tool(client, 'list_notes')).value).toEqual([])

    await tool(client, 'add_note', { body: 'quarterly numbers look good' })
    const found = await tool(client, 'search', { query: 'quarterly numbers', kind: 'note' })
    expect(found.value).toEqual([expect.objectContaining({ space: 'alice' })])
  })
})

describe('index', () => {
  it('indexes notes as kind note', async () => {
    const n = await add({ title: 'Reindex me' })
    expect(services.index.listFiles({ space: 'alice', kind: 'note' }).map((r) => r.path)).toEqual([
      n.path,
    ])
  })
})
