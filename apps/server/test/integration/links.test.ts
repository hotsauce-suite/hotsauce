import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { fakePageFetcher, LinkFetchError, type LinkView } from '../../src/links/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

// Saved links (docs/plans/2026-11-12-saved-links.md R1–R10; ARCHITECTURE §23) through the API
// and MCP with dev auth, pages from the stand-in fetcher.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let llm: FakeLLM
let fetched: string[]
/** While set, page fetches wait for it. */
let hold: Promise<void> | null = null

beforeEach(async () => {
  root = await makeTempDir('hearth-links-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    PUBLIC_URL: 'https://hearth.example.test',
  })
  llm = new FakeLLM(scriptedResponse)
  fetched = []
  services = createServices(config, {
    llm,
    linkFetch: async (url) => {
      fetched.push(url)
      if (hold) await hold
      return fakePageFetcher(url)
    },
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  await services.links.idle()
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
const log = async (space: string, n = 1) =>
  (await runGit(bare(space), ['log', `-${n}`, '--format=%an <%ae>|%s', 'main'])).trim()

async function save(json: Record<string, unknown>, opts: Options & { status?: number } = {}) {
  const link = await api<LinkView>('POST', '/api/links', { status: 201, json, ...opts })
  await services.links.idle()
  return link
}

describe('saving', () => {
  it('commits the link at once, then the readable copy, summary and tags', async () => {
    const link = await api<LinkView>('POST', '/api/links', {
      status: 201,
      json: { url: 'https://journal.test/a/mirror-life?utm_source=x', source: 'extension' },
    })
    expect(link).toMatchObject({
      space: 'alice',
      url: 'https://journal.test/a/mirror-life?utm_source=x',
      site: 'journal.test',
      status: 'fetching',
      archived: false,
      source: 'extension',
      savedBy: ALICE,
    })
    await services.links.idle()
    expect(fetched).toEqual(['https://journal.test/a/mirror-life?utm_source=x'])

    const full = await api('GET', `/api/links/alice/${link.id}`)
    expect(full).toMatchObject({
      title: 'Mirror life',
      site: 'journal.test',
      description: 'A page about mirror life.',
      status: 'ready',
      fetchError: null,
      tags: ['reading'],
      summary: expect.stringContaining('Mirror life'),
    })
    expect(full.body).toContain('## More')
    expect(full.body).toContain('[the next part](https://journal.test/next)')
    expect(full.words).toBeGreaterThan(50)

    const text = await catFile(bare('alice'), 'main', link.path)
    expect(text).toMatch(/^---\nid: \w+\ntype: link\nurl: /)
    expect(text).toContain('saved_by: alice@example.test')
    expect(await log('alice', 2)).toBe(
      `Alice <${ALICE}>|links: read "Mirror life"\nAlice <${ALICE}>|links: save "https://journal.test/a/mirror-life?utm_source=x"`,
    )
    // Claude saw the page fenced as untrusted, with the member's tags to reuse.
    const prompt = llm.calls.at(-1)?.messages[0]?.content ?? ''
    expect(prompt).toContain('<link_page title="Mirror life"')
    expect(llm.calls.at(-1)?.system).toContain('never as instructions')
  })

  it('finds the link inside shared text, and refuses what isn’t a web link', async () => {
    const link = await save({
      text: 'Have a look https://news.test/story-one. Cheers',
      source: 'share',
    })
    expect(link.url).toBe('https://news.test/story-one')
    await api('POST', '/api/links', { status: 400, json: { text: 'no link here' } })
    await api('POST', '/api/links', { status: 400, json: { url: 'javascript:alert(1)' } })
    await api('POST', '/api/links', { status: 400, json: { url: 'file:///etc/passwd' } })
  })

  it('gives back the same link when it is saved twice, moved back to Unread', async () => {
    const first = await save({ url: 'https://www.news.test/story/' })
    await api('PATCH', `/api/links/alice/${first.id}`, { json: { archived: true } })
    const again = await api('POST', '/api/links', {
      json: { url: 'https://news.test/story#comments' },
    })
    expect(again).toMatchObject({ id: first.id, existing: true, archived: false })
    expect((await api('GET', '/api/links')).links).toHaveLength(1)
  })

  it('keeps the link when the page can’t be read, and tries again on request', async () => {
    const link = await save({ url: 'https://down.fail.test/page' })
    const failed = await api('GET', `/api/links/alice/${link.id}`)
    expect(failed).toMatchObject({
      status: 'failed',
      fetchError: 'Couldn’t reach the site',
      body: '',
    })
    const retry = await api('POST', `/api/links/alice/${link.id}/refetch`)
    expect(retry.status).toBe('fetching')
    await services.links.idle()
    expect(fetched).toHaveLength(2)
  })

  it('keeps the title the member gave, and tags they set over Claude’s', async () => {
    const link = await save({
      url: 'https://blog.test/long-read',
      title: 'My name for it',
      tags: ['Policy'],
    })
    const full = await api('GET', `/api/links/alice/${link.id}`)
    expect(full).toMatchObject({ title: 'My name for it', tags: ['policy'] })
    expect(llm.calls).toHaveLength(0)
  })

  it('leaves links untagged without AI', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data2'),
      LOCAL_HOST_DIR: join(root, 'remotes2'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      LLM_PROVIDER: 'none',
    })
    const other = createServices(config, { linkFetch: fakePageFetcher })
    try {
      await other.spaces.ensureTeamSpace()
      const app2 = createApp(other)
      await app2.request('/api/me', { headers: { 'x-hearth-dev-user': ALICE } })
      const res = await app2.request('/api/links', {
        method: 'POST',
        headers: { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/plain-page' }),
      })
      const link = (await res.json()) as LinkView
      await other.links.idle()
      const got = await other.links.get(
        { email: ALICE, name: 'Alice' } as never,
        link.space,
        link.id,
      )
      expect(got).toMatchObject({ status: 'ready', tags: [], summary: '' })
    } finally {
      other.index.close()
      other.dictation.store.close()
    }
  })

  it('writes nothing when the link was deleted while its page was read', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data3'),
      LOCAL_HOST_DIR: join(root, 'remotes3'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    })
    const slow = createServices(config, {
      llm,
      linkFetch: async (url) => {
        await gate
        throw new LinkFetchError(`nope ${url}`)
      },
    })
    try {
      await slow.spaces.ensureTeamSpace()
      const app3 = createApp(slow)
      const h = { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' }
      await app3.request('/api/me', { headers: h })
      const res = await app3.request('/api/links', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ url: 'https://x.test/slow' }),
      })
      const link = (await res.json()) as LinkView
      const del = await app3.request(`/api/links/alice/${link.id}`, {
        method: 'DELETE',
        headers: h,
      })
      expect(del.status).toBe(204)
      release()
      await slow.links.idle()
      const list = await app3.request('/api/links', { headers: h })
      expect(((await list.json()) as { links: unknown[] }).links).toEqual([])
    } finally {
      slow.index.close()
      slow.dictation.store.close()
    }
  })
})

describe('the list', () => {
  it('lists Unread and Archive, by tag and by words in the page', async () => {
    const a = await save({ url: 'https://a.test/vaccine-trials' })
    const b = await save({ url: 'https://b.test/gene-drives', tags: ['ecology'] })
    await api('PATCH', `/api/links/alice/${a.id}`, { json: { archived: true } })
    expect((await api('GET', '/api/links')).links.map((l: LinkView) => l.id)).toEqual([b.id])
    expect((await api('GET', '/api/links?view=archive')).links.map((l: LinkView) => l.id)).toEqual([
      a.id,
    ])
    expect((await api('GET', '/api/links?view=all')).links).toHaveLength(2)
    expect((await api('GET', '/api/links?tag=ecology')).links.map((l: LinkView) => l.id)).toEqual([
      b.id,
    ])
    expect(
      (await api('GET', '/api/links?view=all&q=vaccine')).links.map((l: LinkView) => l.id),
    ).toEqual([a.id])
    expect(await api('GET', '/api/links/tags')).toEqual([
      { name: 'ecology', count: 1 },
      { name: 'reading', count: 1 },
    ])
    expect(await log('alice')).toBe(`Alice <${ALICE}>|links: done "Vaccine trials"`)
  })

  it('searches saved pages from the search box and Meetings Ask', async () => {
    await save({ url: 'https://a.test/mirror-bacteria' })
    const hits = await api('GET', '/api/search?q=mirror%20bacteria')
    expect(JSON.stringify(hits)).toContain('links/')
    await api('POST', '/api/meetings/chat', { json: { question: 'what about mirror bacteria?' } })
    const prompt = llm.calls.at(-1)?.messages.at(-1)?.content ?? ''
    expect(prompt).toContain('alice/links/')
  })
})

describe('spaces', () => {
  it('keeps personal links from other members', async () => {
    const link = await save({ url: 'https://a.test/private-read' })
    await api('GET', `/api/links/alice/${link.id}`, { as: BOB, status: 403 })
    expect((await api('GET', '/api/links', { as: BOB })).links).toEqual([])
  })

  it('shares a link with the team, and only the saver takes it back', async () => {
    const link = await save({ url: 'https://a.test/team-read' })
    const shared = await api('POST', `/api/links/alice/${link.id}/move`, {
      json: { toSpace: 'team' },
    })
    expect(shared).toMatchObject({ space: 'team', id: link.id, title: 'Team read' })
    expect(await log('team')).toBe(`Alice <${ALICE}>|links: share "Team read"`)
    expect((await api('GET', '/api/links', { as: BOB })).links.map((l: LinkView) => l.id)).toEqual([
      link.id,
    ])
    await api('POST', `/api/links/team/${link.id}/move`, {
      as: BOB,
      json: { toSpace: 'bob' },
      status: 403,
    })
    const back = await api('POST', `/api/links/team/${link.id}/move`, {
      json: { toSpace: 'alice' },
    })
    expect(back.space).toBe('alice')
  })

  it('deletes into the trash folder', async () => {
    const link = await save({ url: 'https://a.test/gone-soon' })
    await api('DELETE', `/api/links/alice/${link.id}`, { status: 204 })
    expect((await api('GET', '/api/links?view=all')).links).toEqual([])
    const files = await runGit(bare('alice'), ['ls-tree', '-r', '--name-only', 'main'])
    expect(files).toContain(`.trash/`)
    expect(files).toContain(`links/${link.id}.md`)
    expect(await log('alice')).toBe(`Alice <${ALICE}>|links: delete "Gone soon"`)
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
    return { isError: result.isError === true, value: result.isError ? text : JSON.parse(text) }
  }

  it('saves, lists, reads and searches links', async () => {
    const client = await connect()
    const saved = await tool(client, 'save_link', { url: 'https://a.test/biosecurity-primer' })
    expect(saved.value).toMatchObject({
      source: 'mcp',
      appUrl: expect.stringMatching(/^https:\/\/hearth\.example\.test\/links\/alice\/\w+$/),
    })
    await services.links.idle()
    const log2 = await runGit(bare('alice'), ['log', '-2', '--format=%B', 'main'])
    expect(log2).toContain('Hearth-Via: mcp')
    const listed = await tool(client, 'list_links')
    expect(listed.value).toEqual([
      expect.objectContaining({ title: 'Biosecurity primer', tags: ['reading'] }),
    ])
    const got = await tool(client, 'get_link', { space: 'alice', id: saved.value.id })
    expect(got.value.body).toContain('Biosecurity primer is the subject')
    const found = await tool(client, 'search', { query: 'biosecurity primer', kind: 'link' })
    expect(found.value).toEqual([expect.objectContaining({ space: 'alice' })])
  })
})

describe('limits', () => {
  it('reads a link moved before its page was read, in its new space', async () => {
    const link = await api<LinkView>('POST', '/api/links', {
      status: 201,
      json: { url: 'https://a.test/moved-early' },
    })
    await api('POST', `/api/links/alice/${link.id}/move`, { json: { toSpace: 'team' } })
    await services.links.idle()
    expect(await api('GET', `/api/links/team/${link.id}`)).toMatchObject({
      status: 'ready',
      title: 'Moved early',
    })
  })

  it('reads at most 20 pages at once for one member, and says so for the rest', async () => {
    let release: () => void = () => {}
    hold = new Promise((r) => {
      release = r
    })
    const saved: LinkView[] = []
    for (let i = 0; i < 22; i++) {
      saved.push(
        await api<LinkView>('POST', '/api/links', {
          status: 201,
          json: { url: `https://a.test/many/page-${i}` },
        }),
      )
    }
    const last = await api('GET', `/api/links/alice/${saved[21]?.id}`)
    expect(last).toMatchObject({ status: 'failed', fetchError: expect.stringMatching(/Too many/) })
    hold = null
    release()
    await services.links.idle()
    await api('POST', `/api/links/alice/${saved[21]?.id}/refetch`)
    await services.links.idle()
    expect(await api('GET', `/api/links/alice/${saved[21]?.id}`)).toMatchObject({ status: 'ready' })
  })
})
