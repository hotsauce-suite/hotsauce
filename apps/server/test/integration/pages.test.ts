import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { pageText } from '../../src/pages/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Published pages (docs/plans/2026-11-12-share-pages.md R9, R10, R13; ARCHITECTURE §20.2).

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const PAGE = (h: string) =>
  `<!doctype html><html><head><title>x</title><style>.a{}</style><script>var s=1</script></head><body><h1>${h}</h1><p>Runway &amp; hiring</p></body></html>`

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let alice: Client

beforeEach(async () => {
  root = await makeTempDir('hearth-pages-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    PUBLIC_URL: 'https://hearth.example.test',
  })
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  const res = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'Claude Code' } })
  const { token } = (await res.json()) as { token: string }
  alice = await connect({ authorization: `Bearer ${token}` })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  await alice.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, path: string, opts: { as?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
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
  const res = await call(method, path, { as: ALICE, ...opts })
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
    requestInit: { headers },
    fetch: async (input, init) => app.request(new Request(input, init)),
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = (await alice.callTool({ name, arguments: args })) as CallToolResult
  const first = result.content[0]
  const text = first?.type === 'text' ? first.text : ''
  return { isError: result.isError === true, text, value: result.isError ? null : JSON.parse(text) }
}

const lastCommit = (space: string) =>
  runGit(join(root, 'data', 'repos', space), ['log', '-1', '--format=%an <%ae>%n%B'])

describe('published pages', () => {
  it('publishes a page and new versions, keeps each, and lists it (R9, R10)', async () => {
    const first = await tool('publish_page', { title: 'Q4 plan', html: PAGE('Plan v1') })
    expect(first.isError, first.text).toBe(false)
    const { id, space } = first.value
    expect(first.value).toMatchObject({ space: 'team', title: 'Q4 plan', version: 1 })
    expect(first.value.url).toBe(`https://hearth.example.test/pages/team/${id}`)
    const commit = await lastCommit('team')
    expect(commit).toContain('Alice <alice@example.test>')
    expect(commit).toContain('pages: publish "Q4 plan"')
    expect(commit).toContain('Hearth-Via: mcp (token "Claude Code")')

    const second = await tool('publish_page', { id, title: 'Q4 plan (final)', html: PAGE('v2') })
    expect(second.value).toMatchObject({ id, title: 'Q4 plan (final)', version: 2 })

    const got = await tool('get_page', { space, id })
    expect(got.value.html).toContain('<h1>v2</h1>')
    expect(got.value.versions).toHaveLength(2)
    const oldest = got.value.versions[1].oid
    const v1 = await tool('get_page', { space, id, version: oldest })
    expect(v1.value.html).toContain('<h1>Plan v1</h1>')

    const listed = await tool('list_pages')
    expect(listed.value).toEqual([
      expect.objectContaining({ id, title: 'Q4 plan (final)', createdBy: ALICE, shared: false }),
    ])
    // The web app reads the same, and teammates see team pages.
    const web = await api('GET', `/api/pages/team/${id}?version=${oldest}`, { as: BOB })
    expect(web.html).toContain('Plan v1')
    expect((await api('GET', '/api/pages', { as: BOB })).pages).toHaveLength(1)
    // Its text is searchable; scripts and styles aren't.
    const hits = await api('GET', '/api/search?q=hiring')
    expect(hits.map((h: { path: string }) => h.path)).toContain(`pages/${id}.md`)
    expect((await api('GET', '/api/search?q=var')).length).toBe(0)
  })

  it('keeps personal pages personal and refuses bad input (R9)', async () => {
    const mine = await tool('publish_page', { title: 'Mine', html: PAGE('m'), space: 'alice' })
    expect(mine.value.space).toBe('alice')
    await api('GET', `/api/pages/alice/${mine.value.id}`, { as: BOB, status: 403 })
    expect((await api('GET', '/api/pages', { as: BOB })).pages).toHaveLength(0)

    expect(
      (await tool('publish_page', { title: 'X', html: PAGE('x'), space: 'bob' })).text,
    ).toMatch(/^forbidden/)
    expect(
      (
        await tool('publish_page', {
          title: 'X',
          html: PAGE('x'),
          id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
        })
      ).text,
    ).toMatch(/^not_found/)
    expect((await tool('publish_page', { title: '   ', html: PAGE('x') })).text).toMatch(
      /^bad_request/,
    )
  })

  it('shares a page by link and the link shows the latest HTML (R10)', async () => {
    const { value } = await tool('publish_page', { title: 'Report', html: PAGE('r1') })
    const on = await tool('share_link', { space: 'team', path: `pages/${value.id}.md`, on: true })
    expect(on.value.url).toMatch(/^https:\/\/hearth\.example\.test\/s\/[A-Za-z0-9_-]{16,}$/)
    const token = on.value.token
    await tool('publish_page', { id: value.id, title: 'Report', html: PAGE('r2') })
    const seen = await api('GET', `/api/shared/${token}`, { as: BOB })
    expect(seen).toMatchObject({ kind: 'page', title: 'Report', markdown: '' })
    expect(seen.html).toContain('<h1>r2</h1>')
    expect((await tool('get_page', { space: 'team', id: value.id })).value.share.token).toBe(token)
  })

  it('protects pages from hand edits, and delete moves them to the trash (R13)', async () => {
    const { value } = await tool('publish_page', { title: 'Locked', html: PAGE('l') })
    const res = await call('PUT', '/api/spaces/team/file', {
      as: ALICE,
      json: { path: `pages/${value.id}.html`, content: 'x' },
    })
    expect(res.status).toBe(403)
    const write = await tool('write_file', {
      space: 'team',
      path: `pages/${value.id}.md`,
      content: 'x',
    })
    expect(write.text).toMatch(/^forbidden/)
    expect(
      (await tool('delete_file', { space: 'team', path: `pages/${value.id}.md` })).text,
    ).toMatch(/^forbidden/)

    await api('DELETE', `/api/pages/team/${value.id}`, { status: 204 })
    await api('GET', `/api/pages/team/${value.id}`, { status: 404 })
    expect((await lastCommit('team')).trim()).toContain('pages: delete "Locked"')
  })

  it('never reads page text as the pointer’s frontmatter', async () => {
    const html = '<p>---</p><p>share: AAAAAAAAAAAAAAAAAAAA</p><p>---</p><p>body</p>'
    const { value, text } = await tool('publish_page', { title: 'Sneaky', html })
    expect(text).not.toMatch(/^internal/)
    expect(value.shared).toBe(false)
    await api('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAA', { as: BOB, status: 404 })
    const again = await tool('publish_page', { id: value.id, title: 'Sneaky', html })
    expect(again.value.shared).toBe(false)
  })

  it('pulls readable text out of HTML', () => {
    expect(pageText(PAGE('Hello'))).toBe('x\nHello\nRunway & hiring')
    expect(pageText('<p>a&#33;&#x21;&nbsp;b</p><!-- c -->')).toBe('a!! b')
  })
})
