import { join } from 'node:path'
import { boardPath } from '@hearth/format'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { BoardSummary, BoardView } from '../../src/boards/index.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-boards-')
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
  json?: unknown
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
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
const list = async (as = ALICE, query = '') =>
  (await api<{ boards: BoardSummary[] }>('GET', `/api/boards${query}`, { as })).boards

function el(id: string, version: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'rectangle',
    version,
    versionNonce: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra,
  }
}
const scene = (elements: unknown[], files: Record<string, unknown> = {}) => ({
  elements,
  appState: { viewBackgroundColor: '#ffffff' },
  files,
})

async function create(json: Record<string, unknown>, as = ALICE): Promise<BoardView> {
  return api('POST', '/api/boards', { as, json, status: 201 })
}

describe('boards', () => {
  it('W1: creates a board as a file in the chosen space, committed by the member', async () => {
    const b = await create({ title: 'Roadmap', space: 'team' })
    expect(b).toMatchObject({
      space: 'team',
      title: 'Roadmap',
      createdBy: ALICE,
      scene: { elements: [] },
    })
    expect(b.path).toBe(boardPath(b.id))
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|boards: create "Roadmap"`)
    const text = await catFile(bare('team'), 'main', b.path)
    expect(text).toContain('type: board')
    expect(text).toContain('```excalidraw')
  })

  it('defaults to the personal space', async () => {
    const b = await create({})
    expect(b.space).not.toBe('team')
    expect(b.title).toBe('')
  })

  it('W2: a save persists the scene and the text list; a reload returns the same elements', async () => {
    const b = await create({ title: 'Flow', space: 'team' })
    const s = scene([el('a', 1), el('t', 1, { type: 'text', text: 'Launch checklist' })])
    const saved = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: s, baseBlobOid: b.blobOid },
    })
    expect(saved).toMatchObject({ merged: false, texts: ['Launch checklist'] })
    const again = await api<BoardView>('GET', `/api/boards/team/${b.id}`)
    expect(again.scene.elements).toEqual(s.elements)
    expect(again.blobOid).toBe(saved.blobOid)
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|boards: edit "Flow"`)
    expect(await catFile(bare('team'), 'main', b.path)).toContain('- Launch checklist')
  })

  it('a save with nothing new makes no commit', async () => {
    const b = await create({ title: 'Same', space: 'team', scene: scene([el('a', 1)]) })
    const before = await lastCommit('team')
    const r = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([el('a', 1)]), baseBlobOid: b.blobOid },
    })
    expect(r.blobOid).toBe(b.blobOid)
    expect(await lastCommit('team')).toBe(before)
  })

  it('renames', async () => {
    const b = await create({ title: 'Old', space: 'team' })
    const r = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: { title: ' New  name ' },
    })
    expect(r.title).toBe('New name')
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|boards: rename "New name"`)
  })

  it('W3: two members saving from the same version both keep their shapes; the higher version of a shared one wins', async () => {
    const b = await create({ title: 'Shared', space: 'team' })
    const base = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([el('shared', 1, { x: 0 })]), baseBlobOid: b.blobOid },
    })
    // Alice moves the shared box and adds one; Bob, from the same version, adds his own.
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: {
        scene: scene([el('shared', 2, { x: 50 }), el('alice', 1)]),
        baseBlobOid: base.blobOid,
      },
    })
    const bob = await api<BoardView & { merged: boolean }>('PUT', `/api/boards/team/${b.id}`, {
      as: BOB,
      json: { scene: scene([el('shared', 1, { x: 0 }), el('bob', 1)]), baseBlobOid: base.blobOid },
    })
    expect(bob.merged).toBe(true)
    const ids = bob.scene.elements.map((e) => e.id).sort()
    expect(ids).toEqual(['alice', 'bob', 'shared'])
    expect(bob.scene.elements.find((e) => e.id === 'shared')).toMatchObject({ x: 50, version: 2 })
    const fresh = await api<BoardView>('GET', `/api/boards/team/${b.id}`)
    expect(fresh.scene.elements.map((e) => e.id).sort()).toEqual(['alice', 'bob', 'shared'])
  })

  it('W4: images are references to files in assets/; inline data is dropped and other paths refused', async () => {
    const b = await create({ title: 'Pics', space: 'team' })
    const img = el('i', 1, { type: 'image', fileId: 'f1' })
    const r = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: {
        scene: scene([img], {
          f1: {
            mimeType: 'image/png',
            path: 'assets/2026/11/x.png',
            dataURL: 'data:image/png;base64,AAAA',
          },
          unused: { mimeType: 'image/png', path: 'assets/2026/11/y.png' },
        }),
        baseBlobOid: b.blobOid,
      },
    })
    expect(r.scene.files).toEqual({ f1: { mimeType: 'image/png', path: 'assets/2026/11/x.png' } })
    expect(await catFile(bare('team'), 'main', b.path)).not.toContain('data:image')
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([img], { f1: { mimeType: 'image/png', path: '../secrets.png' } }) },
      status: 400,
    })
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([img], { f1: { mimeType: 'image/png', path: 'docs/plan.md' } }) },
      status: 400,
    })
  })

  it('W5: search finds a board by the text on it; a personal board is invisible to others', async () => {
    const team = await create({ title: 'Team board', space: 'team' })
    await api('PUT', `/api/boards/team/${team.id}`, {
      json: { scene: scene([el('t', 1, { type: 'text', text: 'quarterly flamingo review' })]) },
    })
    const mine = await create({ title: 'Private sketch' })
    await api('PUT', `/api/boards/${mine.space}/${mine.id}`, {
      json: { scene: scene([el('t', 1, { type: 'text', text: 'secret flamingo idea' })]) },
    })
    const hits = await list(ALICE, '?q=flamingo')
    expect(hits.map((h) => h.title).sort()).toEqual(['Private sketch', 'Team board'])
    expect((await list(BOB, '?q=flamingo')).map((h) => h.title)).toEqual(['Team board'])
    expect((await list(BOB)).map((h) => h.title)).toEqual(['Team board'])
    await api('GET', `/api/boards/${mine.space}/${mine.id}`, { as: BOB, status: 403 })
    // Search doesn't see the drawing data.
    expect(await list(ALICE, '?q=rectangle')).toEqual([])
    // The app-wide search finds it too, as a board.
    const hitsAll = await api<Array<{ path: string; title: string }>>(
      'GET',
      '/api/search?q=flamingo',
      { as: BOB },
    )
    expect(hitsAll.map((h) => h.path)).toEqual([team.path])
  })

  it('lists newest change first and survives a full reindex from git', async () => {
    const a = await create({ title: 'A', space: 'team' })
    await create({ title: 'B', space: 'team' })
    await new Promise((r) => setTimeout(r, 1100))
    await api('PUT', `/api/boards/team/${a.id}`, { json: { title: 'A2' } })
    expect((await list()).map((x) => x.title)).toEqual(['A2', 'B'])
    services.index.reindexSpace('team', [])
    expect(await list()).toEqual([])
    await services.indexer.full('team')
    expect((await list()).map((x) => x.title)).toEqual(['A2', 'B'])
    expect(services.index.getFile('team', a.path)).toMatchObject({ kind: 'board', title: 'A2' })
  })

  it('deletes into the trash folder', async () => {
    const b = await create({ title: 'Bye', space: 'team' })
    await api('DELETE', `/api/boards/team/${b.id}`, { status: 204 })
    await api('GET', `/api/boards/team/${b.id}`, { status: 404 })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|boards: delete "Bye"`)
    expect(await list()).toEqual([])
  })

  it('refuses a malformed scene', async () => {
    const b = await create({ space: 'team' })
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: { elements: [{ id: 'x' }] } },
      status: 400,
    })
    await api('GET', '/api/boards/team/not-an-id', { status: 404 })
    // Excalidraw would run an iframe element's HTML for everyone who opens the board.
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([el('f', 1, { type: 'iframe' })]) },
      status: 400,
    })
  })

  it('stores deleted shapes small', async () => {
    const b = await create({ space: 'team' })
    const gone = el('g', 5, {
      type: 'freedraw',
      isDeleted: true,
      points: Array.from({ length: 50 }, (_, i) => [i, i]),
    })
    const saved = await api<BoardView>('PUT', `/api/boards/team/${b.id}`, {
      json: { scene: scene([gone, el('a', 1)]), baseBlobOid: b.blobOid },
    })
    expect(saved.scene.elements[0]).toEqual({
      id: 'g',
      type: 'freedraw',
      version: 5,
      versionNonce: 1,
      isDeleted: true,
    })
  })

  it('MCP: list_boards finds a board by its text and read_board returns text and shape counts', async () => {
    const b = await create({ title: 'Architecture', space: 'team' })
    await api('PUT', `/api/boards/team/${b.id}`, {
      json: {
        scene: scene([el('a', 1), el('b', 1), el('t', 1, { type: 'text', text: 'API gateway' })]),
      },
    })
    const res = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'Claude' } })
    const { token } = (await res.json()) as { token: string }
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult
      const first = r.content[0]
      return JSON.parse(first?.type === 'text' ? first.text : 'null')
    }
    const found = await callTool('list_boards', { q: 'gateway' })
    expect(found.map((x: BoardSummary) => x.id)).toEqual([b.id])
    const read = await callTool('read_board', { space: 'team', id: b.id })
    expect(read).toMatchObject({
      title: 'Architecture',
      texts: ['API gateway'],
      shapes: { rectangle: 2, text: 1 },
    })
    expect(read.scene).toBeUndefined()
    await client.close()
  })
})
