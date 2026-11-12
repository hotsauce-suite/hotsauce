import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { BRIEF_NOTES_PATH, BRIEF_PATH } from '../../src/brief/index.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, type LLMRequest, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let llm: FakeLLM
let respond: (req: LLMRequest) => string | Promise<string>

beforeEach(async () => {
  root = await makeTempDir('hearth-brief-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ORG_NAME: 'Example Co',
    BRIEF_REFRESH_GAP_SECONDS: '0',
  })
  respond = scriptedResponse
  llm = new FakeLLM((req) => respond(req))
  services = createServices(config, { llm })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  await services.briefs.close()
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

function meeting(title: string, date: string, attendees: string[], body: string): string {
  const list = attendees.map((a) => `  - ${a}`).join('\n')
  return `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees:\n${list}\ntranscript: ${slug(title)}.transcript.md\n---\n# ${title}\n\n${body}\n`
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

async function writeMeeting(
  space: string,
  title: string,
  date: string,
  attendees: string[],
  body: string,
  transcript?: string,
  as = ALICE,
) {
  await api('PUT', `/api/spaces/${space}/file`, {
    as,
    json: {
      path: `meetings/2026/11/${slug(title)}.md`,
      content: meeting(title, date, attendees, body),
    },
  })
  if (transcript) {
    await api('PUT', `/api/spaces/${space}/file`, {
      as,
      json: { path: `meetings/2026/11/${slug(title)}.transcript.md`, content: transcript },
    })
  }
}

const briefCalls = () =>
  llm.calls.filter((c) => c.messages[0]?.content.includes('<previous_brief>'))

describe('agent brief', () => {
  it('is empty until there is something to write from', async () => {
    expect(await api('GET', '/api/brief')).toEqual({ brief: null, notes: '' })
    const refreshed = await api('POST', '/api/brief/refresh', { json: {} })
    expect(refreshed).toMatchObject({ status: 'empty', brief: null })
    expect(briefCalls()).toHaveLength(0)
  })

  it('is written from the member’s meetings, shared meetings they attended, and their tasks', async () => {
    await writeMeeting(
      'alice',
      'Northwind pricing',
      daysAgo(1),
      [`Alice <${ALICE}>`, 'Priya <priya@northwind.test>'],
      '## Decisions\n\n- Ship tiered pricing in Q1',
      '[00:00:01] **Me:** Let’s keep it short and ship tiers.\n[00:00:05] **Them:** Fine by us.\n',
    )
    await writeMeeting('alice', 'Old offsite', daysAgo(45), [], 'Long ago')
    await writeMeeting(
      'team',
      'Helios demo',
      daysAgo(2),
      [`Alice <${ALICE}>`],
      'Demo went well',
      undefined,
      BOB,
    )
    await writeMeeting(
      'team',
      'Bob only sync',
      daysAgo(1),
      [`Bob <${BOB}>`],
      'Not Alice’s',
      undefined,
      BOB,
    )
    await api('POST', '/api/tasks/quick', {
      json: { text: 'Send Priya the deck p1', tz: 'UTC' },
      status: 201,
    })

    const res = await api('POST', '/api/brief/refresh', { json: { tz: 'America/New_York' } })
    expect(res.status).toBe('written')
    expect(res.brief).toMatchObject({
      space: 'alice',
      path: BRIEF_PATH,
      meetings: 2,
      tasks: 1,
      model: 'claude-sonnet-5-5',
    })
    expect(res.brief.body).toMatch(/^## Overview\n/)
    expect(res.brief.body).toContain('Newest meeting: Northwind pricing')
    for (const h of [
      'Current priorities',
      'People',
      'Glossary',
      'Communication style',
      'What changed',
    ]) {
      expect(res.brief.body).toContain(`## ${h}`)
    }

    const prompt = briefCalls()[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('Person: Alice <alice@example.test>, at Example Co')
    expect(prompt).toContain('title="Helios demo"')
    expect(prompt).toContain('ship tiers') // what Alice said on her own call
    expect(prompt).not.toContain('Fine by us') // the other side's words aren't "what they said"
    expect(prompt).not.toContain('Old offsite') // outside the 30-day window
    expect(prompt).not.toContain('Bob only sync') // a shared meeting she wasn't at
    expect(prompt).toContain('- Send Priya the deck (open, p1)')

    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|brief: write "Agent brief"`)
    const file = await catFile(bare('alice'), 'main', BRIEF_PATH)
    expect(file).toMatch(/^---\ntype: agent-brief\n/)
    expect(file).toContain('# Agent brief: Alice')

    // Bob can't see it, and has none of his own from Alice's material.
    expect(await api('GET', '/api/brief', { as: BOB })).toEqual({ brief: null, notes: '' })
  })

  it('takes the member’s corrections into the next brief and passes the previous one on', async () => {
    await writeMeeting('alice', 'Weekly sync', daysAgo(1), [], 'Talked roadmap')
    await api('POST', '/api/brief/refresh', { json: {} })
    await api('PUT', '/api/brief/notes', {
      json: { text: 'I lead growth, not sales.' },
      status: 204,
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|brief: correct "Agent brief"`)
    expect(await catFile(bare('alice'), 'main', BRIEF_NOTES_PATH)).toBe('I lead growth, not sales.')

    const res = await api('POST', '/api/brief/refresh', { json: {} })
    expect(res.notes).toBe('I lead growth, not sales.')
    expect(res.brief.body).toContain('Notes: I lead growth, not sales.')
    const prompt = briefCalls().at(-1)?.messages[0]?.content ?? ''
    expect(prompt).toMatch(/<previous_brief>\n## Overview/)
  })

  it('skips the model when nothing changed, unless asked to rewrite', async () => {
    await writeMeeting('alice', 'Weekly sync', daysAgo(1), [], 'Talked roadmap')
    // The nightly pass for a member enrolled with no zone yet.
    await api('GET', '/api/brief')
    await services.briefs.tick()
    expect(briefCalls()).toHaveLength(1)
    // Already checked tonight: nothing more.
    await services.briefs.tick()
    expect(briefCalls()).toHaveLength(1)
    const principal = {
      userId: ALICE,
      email: ALICE,
      name: 'Alice',
      handle: 'alice',
      isAdmin: false,
    }
    expect((await services.briefs.read(principal)).brief?.generated).toBeTruthy()
    // Same material, asked again without force: unchanged.
    expect((await services.briefs.refresh(principal)).status).toBe('unchanged')
    expect(briefCalls()).toHaveLength(1)
    // The button always rewrites.
    expect((await api('POST', '/api/brief/refresh', { json: {} })).status).toBe('written')
    expect(briefCalls()).toHaveLength(2)
  })

  it('refuses notes that are too long and an unknown zone is ignored', async () => {
    await api('PUT', '/api/brief/notes', { json: { text: 'x'.repeat(20_001) }, status: 400 })
    // An unknown zone is ignored rather than refused: the page still loads.
    expect(await api('GET', '/api/brief?tz=Not/AZone')).toEqual({ brief: null, notes: '' })
  })

  it('strips images from what the model writes', async () => {
    await writeMeeting('alice', 'Weekly sync', daysAgo(1), [], 'Talked roadmap')
    respond = () =>
      '## Overview\n\n- You ![x](https://evil.test/p.png) lead <img src="https://evil.test/q"> growth.'
    const res = await api('POST', '/api/brief/refresh', { json: {} })
    expect(res.brief.body).toBe('## Overview\n\n- You  lead  growth.')
  })

  it('tries a failed nightly brief again, then waits for the next night', async () => {
    await writeMeeting('alice', 'Weekly sync', daysAgo(1), [], 'Talked roadmap')
    await api('GET', '/api/brief')
    respond = () => {
      throw new Error('model down')
    }
    await services.briefs.tick()
    await services.briefs.tick()
    expect(briefCalls()).toHaveLength(2) // retried, not skipped
    respond = scriptedResponse
    await services.briefs.tick()
    expect(briefCalls()).toHaveLength(3)
    const principal = {
      userId: ALICE,
      email: ALICE,
      name: 'Alice',
      handle: 'alice',
      isAdmin: false,
    }
    expect((await services.briefs.read(principal)).brief).not.toBeNull()
    await services.briefs.tick()
    expect(briefCalls()).toHaveLength(3) // done for tonight
  })

  it('limits forced rewrites per member', async () => {
    await writeMeeting('alice', 'Weekly sync', daysAgo(1), [], 'Talked roadmap')
    const principal = {
      userId: ALICE,
      email: ALICE,
      name: 'Alice',
      handle: 'alice',
      isAdmin: false,
    }
    for (let i = 0; i < 20; i++) await services.briefs.refresh(principal, { force: true })
    await expect(services.briefs.refresh(principal, { force: true })).rejects.toMatchObject({
      code: 'rate_limited',
    })
    // The nightly, unforced refresh isn't limited.
    expect((await services.briefs.refresh(principal)).status).toBe('unchanged')
  })

  it('reaches agents over MCP, writing the first brief on first use', async () => {
    await writeMeeting('alice', 'Northwind pricing', daysAgo(1), [], 'Tiered pricing')
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { 'x-hearth-dev-user': ALICE } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    expect(client.getInstructions()).toContain('get_agent_brief')
    const result = (await client.callTool({
      name: 'get_agent_brief',
      arguments: {},
    })) as CallToolResult
    const first = result.content[0]
    const value = JSON.parse(first?.type === 'text' ? first.text : '{}')
    expect(result.isError).not.toBe(true)
    expect(value.brief).toContain('Newest meeting: Northwind pricing')
    expect(value.basedOn).toEqual({ meetings: 1, tasks: 0 })
    expect(await runGit(bare('alice'), ['log', '-1', '--format=%B', 'main'])).toContain(
      'Hearth-Via: mcp',
    )
    await client.close()
  })
})
