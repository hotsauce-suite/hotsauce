import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { CHUNK_BYTES } from '../../src/files/index.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, LocalAudioStore, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let config: ReturnType<typeof loadConfig>

beforeEach(async () => {
  root = await makeTempDir('hearth-files-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    AUDIO_STORE: 'local',
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
  body?: Uint8Array
  headers?: Record<string, string>
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    ...(opts.body !== undefined ? { body: opts.body as BodyInit } : {}),
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

/** Uploads `bytes` in chunks the way the web app does. */
async function upload(
  name: string,
  bytes: Uint8Array,
  opts: { space?: string; folder?: string; as?: string } = {},
) {
  const as = opts.as ?? ALICE
  const started = await api<{ id: string; chunkBytes: number; chunks: number }>(
    'POST',
    '/api/files/uploads',
    {
      as,
      status: 201,
      json: { space: opts.space ?? 'team', folder: opts.folder ?? '', name, size: bytes.length },
    },
  )
  for (let seq = 0; seq < started.chunks; seq++) {
    const part = bytes.slice(seq * started.chunkBytes, (seq + 1) * started.chunkBytes)
    await api('PUT', `/api/files/uploads/${started.id}/chunks/${seq}`, {
      as,
      status: 204,
      body: part,
    })
  }
  return api('POST', `/api/files/uploads/${started.id}/complete`, { as })
}

/** A one-page PDF with `text` on it. */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
  return zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
  })
}

describe('uploads and pointers', () => {
  it('stores the bytes, commits a pointer as the member, and reads it back', async () => {
    const bytes = new Uint8Array(CHUNK_BYTES + 1234).map((_, i) => i % 251)
    const f = await upload('big data.bin', bytes, { folder: 'Raw/2026' })
    expect(f).toMatchObject({
      name: 'big data.bin',
      folder: 'Raw/2026',
      size: bytes.length,
      mime: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdBy: ALICE,
      preview: 'none',
      url: `/files/team/${f.id}`,
    })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|files: upload "big data.bin"`)
    const pointer = await catFile(bare('team'), 'main', `files/${f.id}.md`)
    expect(pointer).toContain(`key: files/${f.id}\n`)
    // The bytes are in the store, never in Git.
    const stored = await readFile(new LocalAudioStore(config.DATA_DIR).pathOf(`files/${f.id}`))
    expect(Buffer.compare(stored, Buffer.from(bytes))).toBe(0)

    const seen = await api('GET', `/api/files/item/team/${f.id}`, { as: BOB })
    const res = await call('GET', seen.downloadUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), Buffer.from(bytes))).toBe(0)
    const ranged = await call('GET', seen.contentUrl, { headers: { range: 'bytes=10-19' } })
    // A tampered signature is refused.
    expect((await call('GET', seen.contentUrl.replace(/sig=[^&]+/, 'sig=nope'))).status).toBe(404)
    expect(ranged.status).toBe(206)
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...bytes.slice(10, 20)])
  })

  it('refuses a chunk of the wrong size, missing chunks and someone else’s upload', async () => {
    const started = await api('POST', '/api/files/uploads', {
      status: 201,
      json: { space: 'team', name: 'a.txt', size: 10 },
    })
    await api('PUT', `/api/files/uploads/${started.id}/chunks/0`, {
      status: 400,
      body: new Uint8Array(3),
    })
    await api('POST', `/api/files/uploads/${started.id}/complete`, { status: 409 })
    await api('PUT', `/api/files/uploads/${started.id}/chunks/0`, {
      as: BOB,
      status: 404,
      body: new Uint8Array(10),
    })
    await api('POST', '/api/files/uploads', {
      status: 413,
      json: { space: 'team', name: 'huge', size: 3 * 1024 ** 3 },
    })
  })

  it('finishes once when complete is called twice at the same time, and keeps chunks on failure', async () => {
    const bytes = new TextEncoder().encode('hello twice')
    const started = await api('POST', '/api/files/uploads', {
      status: 201,
      json: { space: 'team', folder: '', name: 'twice.txt', size: bytes.length },
    })
    // Completing before the chunk arrives fails, and the upload can still be finished after.
    await api('POST', `/api/files/uploads/${started.id}/complete`, { status: 409 })
    await api('PUT', `/api/files/uploads/${started.id}/chunks/0`, { status: 204, body: bytes })
    const [a, b] = await Promise.all([
      api('POST', `/api/files/uploads/${started.id}/complete`),
      api('POST', `/api/files/uploads/${started.id}/complete`),
    ])
    expect(a.id).toBe(b.id)
    const again = await api('POST', `/api/files/uploads/${started.id}/complete`)
    expect(again.id).toBe(a.id)
    const listed = await api('GET', '/api/files?space=team')
    expect(listed.files.filter((x: { name: string }) => x.name === 'twice.txt')).toHaveLength(1)
  })

  it('handles an empty file', async () => {
    const f = await upload('empty.txt', new Uint8Array())
    expect(f.size).toBe(0)
    const res = await call('GET', f.contentUrl)
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('rebuilds the same listing after the index is deleted', async () => {
    const a = await upload('one.txt', strToU8('hello one'), { folder: 'A' })
    await upload('two.txt', strToU8('hello two'))
    const before = await api('GET', '/api/files?space=team&folder=A')
    services.index.reindexSpace('team', [])
    expect((await api('GET', '/api/files?space=team&folder=A')).files).toHaveLength(0)
    await services.indexer.full('team')
    const after = await api('GET', '/api/files?space=team&folder=A')
    expect(after.files.map((f: { id: string }) => f.id)).toEqual([a.id])
    expect(after).toEqual(before)
  })
})

describe('browsing and editing', () => {
  it('lists folders first and files by name, and keeps empty folders', async () => {
    await upload('b.txt', strToU8('b'))
    await upload('a.txt', strToU8('a'))
    await upload('deep.txt', strToU8('d'), { folder: 'Contracts/2026' })
    await api('POST', '/api/files/folders', {
      status: 201,
      json: { space: 'team', folder: 'Empty' },
    })
    const top = await api('GET', '/api/files?space=team')
    expect(top.folders).toEqual(['Contracts', 'Empty'])
    expect(top.files.map((f: { name: string }) => f.name)).toEqual(['a.txt', 'b.txt'])
    const contracts = await api('GET', '/api/files?space=team&folder=Contracts')
    expect(contracts.folders).toEqual(['Contracts/2026'])
  })

  it('renames, moves, renames a folder, deletes, and shares', async () => {
    const f = await upload('draft.txt', strToU8('text'), { folder: 'Old' })
    const renamed = await api('PATCH', `/api/files/item/team/${f.id}`, {
      json: { name: 'final.md' },
    })
    expect(renamed).toMatchObject({ name: 'final.md', mime: 'text/markdown', preview: 'text' })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|files: rename "final.md"`)

    await api('PATCH', '/api/files/folders', {
      json: { space: 'team', from: 'Old', to: 'New/Sub' },
    })
    expect((await api('GET', `/api/files/item/team/${f.id}`)).folder).toBe('New/Sub')
    expect((await api('GET', '/api/files?space=team')).folders).toEqual(['New'])

    const shared = await api('POST', `/api/files/item/team/${f.id}/share`, { json: { on: true } })
    expect(shared.shareUrl).toMatch(/^\/files\/s\/[A-Za-z0-9_-]{16,}$/)
    const off = await api('POST', `/api/files/item/team/${f.id}/share`, { json: { on: false } })
    expect(off.shareUrl).toBeNull()

    await api('DELETE', `/api/files/item/team/${f.id}`, { status: 204 })
    await api('GET', `/api/files/item/team/${f.id}`, { status: 404 })
    const tree = await runGit(bare('team'), ['ls-tree', '-r', '--name-only', 'main'])
    expect(tree).toMatch(new RegExp(`\\.trash/.+/files/${f.id}\\.md`))
  })

  it('moves a file to a personal space only for its uploader', async () => {
    const mine = await upload('mine.txt', strToU8('x'))
    const theirs = await upload('theirs.txt', strToU8('y'), { as: BOB })
    const moved = await api('POST', `/api/files/item/team/${mine.id}/move`, {
      json: { to: 'alice' },
    })
    expect(moved.space).toBe('alice')
    await api('GET', `/api/files/item/team/${mine.id}`, { status: 404 })
    await api('POST', `/api/files/item/team/${theirs.id}/move`, {
      json: { to: 'alice' },
      status: 403,
    })
    // The bytes go with it: Alice can still open it.
    expect((await call('GET', moved.contentUrl)).status).toBe(200)
  })
})

describe('personal files and share links', () => {
  it('keeps personal files private unless shared, and a link is revocable', async () => {
    const f = await upload('salary.pdf', pdf('Secret plan'), { space: 'alice' })
    await api('GET', `/api/files/item/alice/${f.id}`, { as: BOB, status: 403 })
    await api('GET', '/api/files?space=alice', { as: BOB, status: 403 })

    const shared = await api('POST', `/api/files/item/alice/${f.id}/share`, { json: { on: true } })
    const token = shared.shareToken as string
    const seen = await api('GET', `/api/files/shared/${token}`, { as: BOB })
    expect(seen).toMatchObject({ id: f.id, name: 'salary.pdf', preview: 'pdf' })
    expect(seen.space).toBeUndefined()
    const bytes = await call('GET', seen.contentUrl)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('application/pdf')
    expect(bytes.headers.get('x-frame-options')).toBe('SAMEORIGIN')

    // Signed out: refused.
    expect((await call('GET', `/api/files/shared/${token}`)).status).toBe(401)

    await api('POST', `/api/files/item/alice/${f.id}/share`, { json: { on: false } })
    await api('GET', `/api/files/shared/${token}`, { as: BOB, status: 404 })
  })

  it('refuses pointers written outside Files, so a revoked link can’t be rebuilt', async () => {
    const f = await upload('salary.pdf', pdf('Secret plan'), { space: 'alice' })
    const pointer = (await api('GET', `/api/spaces/alice/file?path=files/${f.id}.md`)).content
    // Bob copies the pointer into the team space through Docs; Hearth refuses it.
    await api('PUT', '/api/spaces/team/file', {
      as: BOB,
      status: 403,
      json: { path: `files/${f.id}.md`, content: pointer },
    })
    await api('PUT', '/api/spaces/team/file', {
      as: BOB,
      status: 403,
      json: { path: '.hearth/files/folders.json', content: '{"folders":[]}' },
    })
    await api('POST', '/api/spaces/team/move', {
      status: 403,
      json: { from: 'files', to: 'docs/files' },
    })
    await api('GET', `/api/files/item/team/${f.id}`, { as: BOB, status: 404 })
  })

  it('never renders SVG or HTML inline', async () => {
    const f = await upload('x.svg', strToU8('<svg onload="alert(1)"/>'))
    const res = await call('GET', f.contentUrl)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })
})

describe('text, search, Ask and MCP', () => {
  it('pulls text from a PDF and a Word file and finds it in search', async () => {
    const p = await upload('NDA.pdf', pdf('Mutual nondisclosure with Zebrafish Labs'))
    const d = await upload('Plan.docx', docx(['Quarterly okapi roadmap', 'Second line']))
    expect(p.textStatus).toBe('extracted')
    expect(d.textStatus).toBe('extracted')
    expect((await api('GET', `/api/files/item/team/${d.id}?text=1`)).text).toBe(
      'Quarterly okapi roadmap\nSecond line',
    )
    const hits = await api('GET', '/api/search?q=zebrafish')
    expect(JSON.stringify(hits)).toContain(`files/${p.id}.md`)
    const listed = await api('GET', '/api/files?space=team&q=okapi')
    expect(listed.files.map((f: { id: string }) => f.id)).toEqual([d.id])
  })

  it('marks a broken PDF failed but still stores it', async () => {
    const f = await upload('broken.pdf', strToU8('%PDF-1.4 not really'))
    expect(f.textStatus).toBe('failed')
  })

  it('exposes files over MCP', async () => {
    const f = await upload('Deck.docx', docx(['Narwhal pricing']), { folder: 'Sales' })
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { 'x-hearth-dev-user': ALICE } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult
      const first = r.content[0]
      return { isError: r.isError === true, text: first?.type === 'text' ? first.text : '' }
    }
    const listed = JSON.parse((await tool('list_drive_files', { folder: 'Sales' })).text)
    expect(listed.files[0]).toMatchObject({ id: f.id, name: 'Deck.docx', hasText: true })
    const got = JSON.parse((await tool('get_drive_file', { space: 'team', id: f.id })).text)
    expect(got.text).toBe('Narwhal pricing')
    const search = JSON.parse((await tool('search', { query: 'narwhal', kind: 'file' })).text)
    expect(search[0].path).toBe(`files/${f.id}.md`)
    // Bob's personal space stays closed to Alice's agent.
    const bobs = await upload('b.txt', strToU8('b'), { space: 'bob', as: BOB })
    expect((await tool('get_drive_file', { space: 'bob', id: bobs.id })).isError).toBe(true)
  })
})
