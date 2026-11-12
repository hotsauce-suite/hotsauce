import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { writeXlsx } from '../../src/tables/xlsx.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

// Hearth Tables (docs/plans/2026-11-12-tables.md T1–T7, T10; ARCHITECTURE §22) through the API
// and MCP with dev auth.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-tables-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    PUBLIC_URL: 'https://hearth.example.test',
  })
  services = createServices(config, { llm: new FakeLLM(() => 'ok') })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; body?: BodyInit } = {},
) {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; body?: BodyInit; status?: number } = {},
): Promise<T> {
  const res = await call(method, path, opts)
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

const repo = (space: string) => join(root, 'data', 'repos', space)
const lastCommit = (space: string) => runGit(repo(space), ['log', '-1', '--format=%an <%ae>%n%B'])

const CELLS = [
  ['Item', 'Price', 'Qty', 'Total'],
  ['Tips', '3', '4', '=B2*C2'],
  ['Gloves, nitrile', '2.5', '10', '=B3*C3'],
  ['', '', 'Sum', '=SUM(D2:D3)'],
]

async function makeTable(space = 'team', as = ALICE) {
  const t = await api('POST', '/api/tables', { as, json: { space, title: 'Lab supplies' } })
  return api('PUT', `/api/tables/${space}/${t.id}`, {
    as,
    json: {
      title: 'Lab supplies',
      columns: [{ type: 'text' }, { type: 'number' }, { type: 'number' }, { type: 'number' }],
      cells: CELLS,
      blobOid: t.blobOid,
    },
  })
}

function upload(name: string, bytes: BodyInit | Uint8Array, space = 'team') {
  const fd = new FormData()
  fd.set('space', space)
  fd.set('file', new File([bytes as BlobPart], name))
  return fd
}

describe('Tables', () => {
  it('creates, saves and lists a table as a CSV block in a file (T1–T3)', async () => {
    const t = await makeTable()
    expect(t.cells).toEqual(CELLS)
    const file = await catFile(repo('team'), 'HEAD', `tables/${t.id}.md`)
    expect(file).toContain('type: table')
    expect(file).toContain(
      '```csv\nItem,Price,Qty,Total\nTips,3,4,=B2*C2\n"Gloves, nitrile",2.5,10,=B3*C3\n',
    )
    expect(await lastCommit('team')).toContain(`Alice <${ALICE}>`)
    expect(await lastCommit('team')).toContain('tables: edit "Lab supplies"')
    const { tables } = await api('GET', '/api/tables')
    expect(tables).toEqual([
      expect.objectContaining({ id: t.id, space: 'team', title: 'Lab supplies' }),
    ])
    // Any member sees a team table.
    expect((await api('GET', `/api/tables/team/${t.id}`, { as: BOB })).cells).toEqual(CELLS)
  })

  it('refuses a stale save, a bad size and writes from outside Tables (T2, T3)', async () => {
    const t = await makeTable()
    const old = (await api('POST', '/api/tables', { json: { space: 'team', title: 'x' } })).blobOid
    await api('PUT', `/api/tables/team/${t.id}`, {
      json: { title: 'Lab supplies', columns: [], cells: [['a']], blobOid: old },
      status: 409,
    })
    await api('PUT', `/api/tables/team/${t.id}`, {
      json: {
        title: 'x',
        columns: [],
        cells: [Array.from({ length: 53 }, () => 'a')],
        blobOid: t.blobOid,
      },
      status: 400,
    })
    const res = await call('PUT', '/api/spaces/team/file', {
      json: { path: `tables/${t.id}.md`, content: 'x' },
    })
    expect(res.status).toBe(403)
  })

  it('keeps a personal table to its owner and deletes to the trash', async () => {
    const me = await api('GET', '/api/me')
    const personal = me.spaces.find((s: { kind: string }) => s.kind === 'personal').name
    const t = await makeTable(personal)
    await api('GET', `/api/tables/${personal}/${t.id}`, { as: BOB, status: 403 })
    expect((await api('GET', '/api/tables', { as: BOB })).tables).toEqual([])
    await api('DELETE', `/api/tables/${personal}/${t.id}`, { status: 204 })
    await api('GET', `/api/tables/${personal}/${t.id}`, { status: 404 })
    const trashed = await runGit(repo(personal), ['ls-files', '.trash'])
    expect(trashed).toContain(`tables/${t.id}.md`)
  })

  it('exports values as CSV and formulas with values as .xlsx (T4, T5)', async () => {
    const t = await makeTable()
    const raw = new Uint8Array(
      await (await call('GET', `/api/tables/team/${t.id}/csv`)).arrayBuffer(),
    )
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(raw.slice(3))).toBe(
      'Item,Price,Qty,Total\r\nTips,3,4,12\r\n"Gloves, nitrile",2.5,10,25\r\n,,Sum,37\r\n',
    )
    const res = await call('GET', `/api/tables/team/${t.id}/xlsx`)
    expect(res.headers.get('content-disposition')).toContain('Lab supplies.xlsx')
    const sheet = strFromU8(
      unzipSync(new Uint8Array(await res.arrayBuffer()))['xl/worksheets/sheet1.xml'] as Uint8Array,
    )
    expect(sheet).toContain('<c r="D4"><f>SUM(D2:D3)</f><v>37</v></c>')
  })

  it('imports a .csv and an .xlsx as new tables (T5)', async () => {
    const fromCsv = await api('POST', '/api/tables/import', {
      body: upload('Vendors.csv', 'Name,Score\nAcme,"=1+1"\n'),
    })
    expect(fromCsv).toMatchObject({
      title: 'Vendors',
      cells: [
        ['Name', 'Score'],
        ['Acme', '=1+1'],
      ],
    })
    const bytes = writeXlsx('S', CELLS, CELLS)
    const fromXlsx = await api('POST', '/api/tables/import', { body: upload('Budget.xlsx', bytes) })
    expect(fromXlsx).toMatchObject({ title: 'Budget', cells: CELLS })
    await api('POST', '/api/tables/import', { body: upload('notes.pdf', 'x'), status: 400 })
    await api('POST', '/api/tables/import', { body: upload('bad.xlsx', 'not a zip'), status: 400 })
    // A file of commas and blank lines is refused before it becomes a grid.
    const wide = `a${','.repeat(200_000)}b\n`
    await api('POST', '/api/tables/import', { body: upload('wide.csv', wide), status: 400 })
    const tall = `a${'\n'.repeat(6000)}c\n`
    await api('POST', '/api/tables/import', { body: upload('tall.csv', tall), status: 400 })
    // Trailing empty columns, as spreadsheets export them, are fine.
    const padded = await api('POST', '/api/tables/import', {
      body: upload('padded.csv', `x,y${','.repeat(100)}\n1,2${','.repeat(100)}\n`),
    })
    expect(padded.cells).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ])
  })

  it('opens a form’s answers as a table and copies them into a new one (T6)', async () => {
    const form = await api('POST', '/api/forms', { json: { space: 'team', title: 'Signup' } })
    await api('PUT', `/api/forms/team/${form.id}`, {
      json: {
        title: 'Signup',
        description: '',
        questions: [
          { id: 'name', type: 'short', label: 'Name', required: true },
          { id: 'team', type: 'choice', label: 'Team', options: ['Lab', 'Ops'], required: true },
          { id: 'stars', type: 'rating', label: 'Stars', scale: 5 },
        ],
        access: 'team',
        open: true,
        room: null,
        blobOid: form.blobOid,
      },
    })
    const link = new URL(form.url).pathname.split('/').pop()
    await api('POST', `/api/form/${link}`, {
      as: BOB,
      json: { answers: { name: '=cmd', team: 'Lab', stars: 4 } },
    })
    const live = await api('GET', `/api/forms/team/${form.id}/table`)
    expect(live.columns.map((c: { type: string }) => c.type)).toEqual([
      'text',
      'person',
      'text',
      'choice',
      'number',
    ])
    expect(live.cells[0]).toEqual(['Submitted', 'From', 'Name', 'Team', 'Stars'])
    expect(live.cells[1].slice(1)).toEqual([BOB, "'=cmd", 'Lab', '4'])
    const copy = await api('POST', '/api/tables', {
      json: { space: 'team', fromForm: { space: 'team', id: form.id } },
    })
    expect(copy.title).toBe('Signup answers')
    // An answer is never a formula in the copy.
    expect(copy.cells[1][2]).toBe("'=cmd")
    expect(copy.columns[3]).toEqual({ type: 'choice', options: ['Lab', 'Ops'] })
  })

  it('finds a table in search by its cells (T10)', async () => {
    const t = await makeTable()
    const hits = await api('GET', '/api/search?q=nitrile')
    expect(JSON.stringify(hits)).toContain(`tables/${t.id}.md`)
  })

  it('MCP: list, read with values, update by address and create (T7)', async () => {
    const t = await makeTable()
    const res = await call('POST', '/api/tokens', { json: { name: 'Claude' } })
    const { token } = (await res.json()) as { token: string }
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult
      const first = r.content[0]
      const text = first?.type === 'text' ? first.text : ''
      return r.isError ? { error: text } : JSON.parse(text)
    }
    expect((await tool('list_tables', { q: 'supplies' })).map((x: { id: string }) => x.id)).toEqual(
      [t.id],
    )
    const read = await tool('read_table', { space: 'team', id: t.id })
    expect(read.rows[3]).toEqual(['', '', 'Sum', '37'])
    expect(read.formulas).toEqual({ D2: '=B2*C2', D3: '=B3*C3', D4: '=SUM(D2:D3)' })
    expect(read.url).toBe(`https://hearth.example.test/tables/team/${t.id}`)
    const updated = await tool('update_table', {
      space: 'team',
      id: t.id,
      set: { B2: '5', D4: '=SUM(D2:D3)+D5' },
      append: [['Tape', '1', '3', '=B5*C5']],
      blobOid: read.blobOid,
    })
    expect(updated.rows[3]).toEqual(['', '', 'Sum', '48'])
    expect(updated.rows[4]).toEqual(['Tape', '1', '3', '3'])
    expect(await lastCommit('team')).toContain('Hearth-Via: mcp')
    const stale = await tool('update_table', {
      space: 'team',
      id: t.id,
      set: { A1: 'x' },
      blobOid: read.blobOid,
    })
    expect(stale.error).toMatch(/conflict/)
    const made = await tool('create_table', {
      title: 'Grants',
      rows: [
        ['Funder', 'Amount'],
        ['NSF', '100'],
      ],
    })
    expect((await api('GET', `/api/tables/team/${made.id}`)).cells).toEqual([
      ['Funder', 'Amount'],
      ['NSF', '100'],
    ])
    await client.close()
  })
})
