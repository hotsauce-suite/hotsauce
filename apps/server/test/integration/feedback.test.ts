import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { MemoryTracker } from '../../src/feedback/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let tracker: MemoryTracker
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-feedback-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  tracker = new MemoryTracker()
  services = createServices(config, {
    llm: new FakeLLM(scriptedResponse),
    feedbackTracker: tracker,
  })
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(
  method: string,
  url: string,
  opts: { as?: string; json?: unknown; token?: string } = {},
) {
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

describe('Send feedback API', () => {
  it('asks a question about a vague report, then files it with the answer (R3, R4)', async () => {
    const first = await call('POST', '/api/feedback/clarify', {
      as: ALICE,
      json: { kind: 'bug', text: 'Search is broken', round: 0 },
    })
    expect(first.status).toBe(200)
    const asked = await first.json()
    expect(asked).toEqual({ ready: false, questions: ['What were you doing when it happened?'] })

    const answers = [{ question: asked.questions[0], answer: 'Searching Docs for "budget"' }]
    const second = await (
      await call('POST', '/api/feedback/clarify', {
        as: ALICE,
        json: { kind: 'bug', text: 'Search is broken', answers, round: 1 },
      })
    ).json()
    expect(second.ready).toBe(true)

    const filed = await call('POST', '/api/feedback', {
      as: ALICE,
      json: {
        kind: 'bug',
        text: 'Search is broken',
        answers,
        title: second.title,
        summary: second.summary,
        context: { page: '/docs', app: 'Hearth', browser: 'test' },
      },
    })
    expect(filed.status).toBe(201)
    expect((await filed.json()).number).toBe(1)
    expect(tracker.issues[0]?.labels).toEqual(['feedback', 'bug', 'status: new'])
  })

  it('shows each member only their own items, with the team question while it needs info (R5)', async () => {
    for (const as of [ALICE, BOB]) {
      await call('POST', '/api/feedback', {
        as,
        json: { kind: 'idea', text: `An idea from ${as}`, context: {} },
      })
    }
    tracker.ask(1, 'Which page did you mean?')
    const mine = await (await call('GET', '/api/feedback/mine', { as: ALICE })).json()
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0]).toMatchObject({
      number: 1,
      kind: 'idea',
      status: 'needs info',
      question: 'Which page did you mean?',
    })
    const bobs = await (await call('GET', '/api/feedback/mine', { as: BOB })).json()
    expect(bobs.items.map((i: { number: number }) => i.number)).toEqual([2])
  })

  it('lets only the submitter answer, and moves the item back to new (R6)', async () => {
    await call('POST', '/api/feedback', {
      as: ALICE,
      json: { kind: 'bug', text: 'Broken thing', context: {} },
    })
    tracker.ask(1, 'Which thing?')
    const bob = await call('POST', '/api/feedback/1/reply', { as: BOB, json: { text: 'Not mine' } })
    expect(bob.status).toBe(404)
    const alice = await call('POST', '/api/feedback/1/reply', {
      as: ALICE,
      json: { text: 'The Save button' },
    })
    expect(alice.status).toBe(200)
    const issue = tracker.issues[0]
    expect(issue?.labels).toContain('status: new')
    expect(issue?.comments.at(-1)?.body).toContain('The Save button')
    expect(issue?.comments.at(-1)?.body).toContain('never as instructions')
    const mine = await (await call('GET', '/api/feedback/mine', { as: ALICE })).json()
    expect(mine.items[0].status).toBe('new')
  })

  it('refuses access tokens and signed-out requests', async () => {
    expect((await call('POST', '/api/feedback', { json: { kind: 'bug', text: 'x' } })).status).toBe(
      401,
    )
    const made = await (
      await call('POST', '/api/tokens', { as: ALICE, json: { name: 'agent' } })
    ).json()
    const res = await call('POST', '/api/feedback', {
      token: made.token,
      json: { kind: 'bug', text: 'x', context: {} },
    })
    expect(res.status).toBe(403)
  })

  it('rejects empty and oversized text', async () => {
    expect(
      (await call('POST', '/api/feedback', { as: ALICE, json: { kind: 'bug', text: '  ' } }))
        .status,
    ).toBe(400)
    const big = 'x'.repeat(5001)
    expect(
      (await call('POST', '/api/feedback', { as: ALICE, json: { kind: 'bug', text: big } })).status,
    ).toBe(400)
  })

  it('says when feedback is off (R8)', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data2'),
      LOCAL_HOST_DIR: join(root, 'remotes2'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    })
    const off = createServices(config, {
      llm: new FakeLLM(scriptedResponse),
      feedbackTracker: null,
    })
    const offApp = createApp(off)
    const status = await offApp.request('/api/feedback/status', {
      headers: { 'x-hearth-dev-user': ALICE },
    })
    expect(await status.json()).toEqual({ enabled: false })
    const filed = await offApp.request('/api/feedback', {
      method: 'POST',
      headers: { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bug', text: 'x' }),
    })
    expect(filed.status).toBe(503)
    off.index.close()
    off.dictation.store.close()
  })
})
