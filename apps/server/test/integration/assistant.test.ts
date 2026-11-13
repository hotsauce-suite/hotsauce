import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AssistantModel, ModelTurn, ModelTurnRequest } from '../../src/assistant/model.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type ServiceOverrides, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

async function start(env: Record<string, string> = {}, overrides: ServiceOverrides = {}) {
  root = await makeTempDir('hearth-assistant-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ALICE,
    WEBHOOK_SECRET: 'test-webhook-secret',
    ...env,
  })
  services = createServices(config, overrides)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
}

afterEach(async () => {
  services.index.close()
  services.assistant.store.close()
  await removeDir(root)
})

async function call(method: string, path: string, opts: { as: string; json?: unknown }) {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

async function put(as: string, space: string, path: string, content: string) {
  const res = await call('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function read(as: string, space: string, path: string): Promise<string | null> {
  const res = await call('GET', `/api/spaces/${space}/file?path=${encodeURIComponent(path)}`, {
    as,
  })
  if (res.status === 404) return null
  expect(res.status).toBe(200)
  return ((await res.json()) as { content: string }).content
}

interface Event {
  type: string
  [key: string]: unknown
}

/** Posts a message and returns the Server-Sent Events it streamed. */
async function ask(as: string, conversation: string, text: string, extra: object = {}) {
  const res = await call('POST', `/api/assistant/conversations/${conversation}/messages`, {
    as,
    json: { text, ...extra },
  })
  if (res.status !== 200)
    return { status: res.status, events: [] as Event[], body: await res.text() }
  const raw = await res.text()
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event)
  return { status: 200, events, body: raw }
}

/** A model that plays back tool calls, then answers with the tool results' first line. */
class Scripted implements AssistantModel {
  readonly requests: ModelTurnRequest[] = []
  constructor(private readonly calls: Array<Array<{ name: string; input: object }>>) {}
  async turn(req: ModelTurnRequest, onText: (d: string) => void): Promise<ModelTurn> {
    this.requests.push({ ...req, messages: [...req.messages] })
    const step = this.requests.length - 1
    const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }
    const calls = this.calls[step]
    if (calls) {
      return {
        content: calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${step}_${i}`, ...c })),
        stopReason: 'tool_use',
        usage,
      }
    }
    onText('All done.')
    return { content: [{ type: 'text', text: 'All done.' }], stopReason: 'end_turn', usage }
  }
}

const CONV = 'conv0000001'

describe('the assistant with the stand-in model', () => {
  beforeEach(() => start())

  it('searches the workspace, streams tool activity and an answer with links, and keeps the conversation', async () => {
    await put(
      ALICE,
      'team',
      'docs/quokka-plan.md',
      '# Quokka plan\n\nThe quokka launch is in May.\n',
    )
    const { status, events } = await ask(ALICE, CONV, 'When is the quokka launch?')
    expect(status).toBe(200)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('tool')
    expect(events[0]).toMatchObject({ name: 'search', kind: 'read' })
    expect(types).toContain('tool_result')
    expect(types.at(-1)).toBe('done')
    const answer = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('')
    expect(answer).toContain('(hearth:team/docs/quokka-plan.md)')

    const list = await (await call('GET', '/api/assistant/conversations', { as: ALICE })).json()
    expect(list.conversations).toMatchObject([{ id: CONV, title: 'When is the quokka launch?' }])
    const conv = await (
      await call('GET', `/api/assistant/conversations/${CONV}`, { as: ALICE })
    ).json()
    expect(conv.display.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant'])
    expect(conv.display[1].tools[0]).toMatchObject({ name: 'search', status: 'done' })
    expect(conv.messages).toBeUndefined()
  })

  it("keeps each member's conversations private", async () => {
    await ask(ALICE, CONV, 'hello')
    expect((await call('GET', `/api/assistant/conversations/${CONV}`, { as: BOB })).status).toBe(
      404,
    )
    expect((await call('DELETE', `/api/assistant/conversations/${CONV}`, { as: BOB })).status).toBe(
      404,
    )
    const hijack = await ask(BOB, CONV, 'hello')
    expect(hijack.events.at(-1)).toMatchObject({ type: 'error', message: 'No such conversation' })
    const bobs = await (await call('GET', '/api/assistant/conversations', { as: BOB })).json()
    expect(bobs.conversations).toEqual([])
    expect(
      (await call('DELETE', `/api/assistant/conversations/${CONV}`, { as: ALICE })).status,
    ).toBe(204)
    expect((await call('GET', `/api/assistant/conversations/${CONV}`, { as: ALICE })).status).toBe(
      404,
    )
  })

  it('waits for Confirm before deleting, then runs exactly that delete once', async () => {
    await put(ALICE, 'team', 'docs/old-notes.md', '# Old notes\n')
    const { events } = await ask(ALICE, CONV, 'delete team/docs/old-notes.md')
    expect(events.find((e) => e.type === 'confirm')).toMatchObject({
      name: 'delete_file',
      input: { space: 'team', path: 'docs/old-notes.md' },
    })
    expect(await read(ALICE, 'team', 'docs/old-notes.md')).toContain('Old notes')
    const toolId = (events.find((e) => e.type === 'confirm') as Event).id as string

    expect(
      (
        await call('POST', `/api/assistant/conversations/${CONV}/confirm`, {
          as: BOB,
          json: { toolId },
        })
      ).status,
    ).toBe(404)
    const ok = await call('POST', `/api/assistant/conversations/${CONV}/confirm`, {
      as: ALICE,
      json: { toolId },
    })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect(await read(ALICE, 'team', 'docs/old-notes.md')).toBeNull()
    const again = await call('POST', `/api/assistant/conversations/${CONV}/confirm`, {
      as: ALICE,
      json: { toolId },
    })
    expect(again.status).toBe(409)
    const conv = await (
      await call('GET', `/api/assistant/conversations/${CONV}`, { as: ALICE })
    ).json()
    expect(conv.display[1].tools[0].status).toBe('confirmed')
  })

  it('sends the open page as context and refuses a page the member cannot see', async () => {
    await put(BOB, 'bob', 'docs/secret.md', '# Secret\n')
    const refused = await ask(ALICE, CONV, 'summarize this', {
      context: { space: 'bob', path: 'docs/secret.md', title: 'Secret' },
    })
    expect(refused.events.at(-1)).toMatchObject({ type: 'error' })
    const fine = await ask(ALICE, 'conv0000002', 'summarize this', {
      context: { space: 'team', path: 'docs/a.md', title: 'A' },
    })
    expect(fine.events.at(-1)).toMatchObject({ type: 'done' })
    const conv = await (
      await call('GET', '/api/assistant/conversations/conv0000002', { as: ALICE })
    ).json()
    expect(conv.display[0].context).toEqual({ space: 'team', path: 'docs/a.md', title: 'A' })
  })

  it('names itself after the workspace', async () => {
    const res = await (await call('GET', '/api/assistant', { as: ALICE })).json()
    expect(res).toEqual({ name: 'Ask Hotsauce', configured: true })
  })
})

describe('the assistant with a scripted model', () => {
  it("acts with the member's own access", async () => {
    const model = new Scripted([
      [{ name: 'read_file', input: { space: 'bob', path: 'docs/secret.md' } }],
    ])
    await start({}, { assistantModel: model })
    await put(BOB, 'bob', 'docs/secret.md', '# Secret\n')
    const { events } = await ask(ALICE, CONV, 'read bob secret')
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true })
    const result = model.requests[1]?.messages.at(-1)
    expect(JSON.stringify(result)).toContain(
      `forbidden: You don't have access to the space \\"bob\\"`,
    )
  })

  it('puts the page context and the date in front of the question, and tools in a stable order', async () => {
    const model = new Scripted([])
    await start({}, { assistantModel: model })
    await ask(ALICE, CONV, 'what is this?', {
      context: { space: 'team', path: 'docs/a.md', title: 'A doc' },
      tz: 'America/Los_Angeles',
    })
    const first = JSON.stringify(model.requests[0]?.messages[0])
    expect(first).toContain('A doc')
    expect(first).toContain('America/Los_Angeles')
    expect(first).toContain('what is this?')
    const names = model.requests[0]?.tools.map((t) => t.name) ?? []
    expect(names).toEqual([...names].sort())
    expect(names).toContain('search')
    expect(model.requests[0]?.system).toContain('Ask Hotsauce')
  })

  it('offers Undo for an edit and a create, and Undo puts the files back', async () => {
    const model = new Scripted([
      [
        {
          name: 'write_file',
          input: { space: 'team', path: 'docs/plan.md', content: '# Plan\n\nRewritten.\n' },
        },
        { name: 'write_file', input: { space: 'alice', path: 'docs/new.md', content: '# New\n' } },
      ],
    ])
    await start({}, { assistantModel: model })
    await put(ALICE, 'team', 'docs/plan.md', '# Plan\n\nOriginal.\n')
    const { events } = await ask(ALICE, CONV, 'rewrite the plan and start a new doc')
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(2)
    expect(await read(ALICE, 'team', 'docs/plan.md')).toContain('Rewritten')
    for (const r of results) {
      expect(typeof r.undo).toBe('string')
      expect((await call('POST', `/api/assistant/undo/${r.undo}`, { as: BOB })).status).toBe(404)
      const res = await call('POST', `/api/assistant/undo/${r.undo}`, { as: ALICE })
      expect(res.status, await res.clone().text()).toBe(200)
    }
    expect(await read(ALICE, 'team', 'docs/plan.md')).toContain('Original')
    expect(await read(ALICE, 'alice', 'docs/new.md')).toBeNull()
    expect(
      (await call('POST', `/api/assistant/undo/${results[0]?.undo}`, { as: ALICE })).status,
    ).toBe(409)
    const conv = await (
      await call('GET', `/api/assistant/conversations/${CONV}`, { as: ALICE })
    ).json()
    expect(conv.display[1].tools.map((t: { status: string }) => t.status)).toEqual([
      'undone',
      'undone',
    ])
  })

  it("refuses Undo when the file changed since, and never reverts a teammate's commit", async () => {
    const model = new Scripted([
      [
        {
          name: 'write_file',
          input: { space: 'team', path: 'docs/plan.md', content: '# Plan\n\nBy the assistant.\n' },
        },
      ],
    ])
    await start({}, { assistantModel: model })
    await put(ALICE, 'team', 'docs/plan.md', '# Plan\n\nOriginal.\n')
    const { events } = await ask(ALICE, CONV, 'rewrite')
    const undo = events.find((e) => e.type === 'tool_result')?.undo as string
    await put(BOB, 'team', 'docs/plan.md', '# Plan\n\nBob edited after.\n')
    expect((await call('POST', `/api/assistant/undo/${undo}`, { as: ALICE })).status).toBe(409)
    expect(await read(ALICE, 'team', 'docs/plan.md')).toContain('Bob edited after')
  })

  it('reads need no Undo, and a failed write offers none', async () => {
    const model = new Scripted([
      [
        { name: 'list_spaces', input: {} },
        { name: 'write_file', input: { space: 'bob', path: 'docs/x.md', content: 'x' } },
      ],
    ])
    await start({}, { assistantModel: model })
    const { events } = await ask(ALICE, CONV, 'go')
    for (const r of events.filter((e) => e.type === 'tool_result')) expect(r.undo).toBeUndefined()
  })

  it('counts usage per member per month; only admins see it; the limit refuses with a plain message', async () => {
    const model = new Scripted([])
    await start({ ASSISTANT_MONTHLY_LIMIT_USD: '0.003' }, { assistantModel: model })
    // 1000 input + 100 output tokens of Sonnet 5.5 is $0.003: the first question uses it up.
    expect((await ask(BOB, CONV, 'one')).status).toBe(200)
    const over = await ask(BOB, 'conv0000002', 'two')
    expect(over.status).toBe(429)
    expect(over.body).toContain('allowance')
    expect((await call('GET', '/api/assistant/usage', { as: BOB })).status).toBe(403)
    const usage = await (await call('GET', '/api/assistant/usage', { as: ALICE })).json()
    expect(usage.members).toMatchObject([{ email: BOB, questions: 1, input: 1000, output: 100 }])
    expect(usage.members[0].costUsd).toBeCloseTo(0.003, 6)
  })
})

describe('without an Anthropic key', () => {
  beforeEach(() => start({ LLM_PROVIDER: 'none' }))

  it('says so instead of answering', async () => {
    const res = await (await call('GET', '/api/assistant', { as: ALICE })).json()
    expect(res.configured).toBe(false)
    const { status, body } = await ask(ALICE, CONV, 'hi')
    expect(status).toBe(503)
    expect(body).toContain('Anthropic API key')
  })
})
