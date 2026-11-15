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
  root = await makeTempDir('hotsauce-feedback-')
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
        context: { page: '/docs', app: 'Hotsauce', browser: 'test' },
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

// docs/PLAN-feedback-screenshots.md S4.
describe('Send feedback with screenshots', () => {
  const png = (size = 16) => {
    const bytes = new Uint8Array(size)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return bytes
  }
  const payload = { kind: 'bug', text: 'The chart is blank on Today', context: { page: '/today' } }
  const send = (files: { bytes: Uint8Array; type: string; name?: string }[], body = payload) => {
    const form = new FormData()
    form.set('payload', JSON.stringify(body))
    for (const f of files) {
      form.append(
        'screenshot',
        new File([f.bytes as Uint8Array<ArrayBuffer>], f.name ?? 'shot.png', { type: f.type }),
      )
    }
    return app.request('/api/feedback', {
      method: 'POST',
      headers: { 'x-hearth-dev-user': ALICE },
      body: form,
    })
  }

  it('saves the pictures and files the issue with them', async () => {
    const res = await send([
      { bytes: png(), type: 'image/png' },
      { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), type: 'image/jpeg', name: 'p.jpg' },
    ])
    expect(res.status).toBe(201)
    expect(tracker.uploads).toHaveLength(2)
    const body = tracker.issues[0]?.body ?? ''
    expect(body).toContain('The chart is blank on Today')
    expect(body).toContain('![Screenshot 1](https://github.invalid/feedback/blob/main/screenshots/')
    expect(body).toContain('![Screenshot 2]')
  })

  it('takes a 4 MB picture, above the old JSON route limit for three of them', async () => {
    const big = png(4 * 1024 * 1024)
    const res = await send([
      { bytes: big, type: 'image/png' },
      { bytes: big, type: 'image/png' },
      { bytes: big, type: 'image/png' },
    ])
    expect(res.status).toBe(201)
    expect(tracker.uploads).toHaveLength(3)
  })

  it('refuses a fourth picture, a fake image and an oversized one', async () => {
    const four = await send(Array.from({ length: 4 }, () => ({ bytes: png(), type: 'image/png' })))
    expect(four.status).toBe(400)
    const svg = await send([
      {
        bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        type: 'image/png',
      },
    ])
    expect(svg.status).toBe(400)
    expect((await svg.json()).error.message).toMatch(/PNG, JPEG, WebP or GIF/)
    const huge = await send([{ bytes: png(5 * 1024 * 1024 + 1), type: 'image/png' }])
    expect(huge.status).toBe(400)
    expect(tracker.issues).toEqual([])
    expect(tracker.uploads).toEqual([])
  })

  it('refuses a body far beyond three pictures', async () => {
    const res = await send([{ bytes: new Uint8Array(17 * 1024 * 1024), type: 'image/png' }])
    expect(res.status).toBe(413)
  })

  it('checks the payload as strictly as the JSON route', async () => {
    const res = await send([{ bytes: png(), type: 'image/png' }], {
      ...payload,
      kind: 'rant',
    } as typeof payload)
    expect(res.status).toBe(400)
    expect(tracker.issues).toEqual([])
  })

  it('keeps the usual body limit on other routes', async () => {
    const res = await app.request('/api/feedback/clarify', {
      method: 'POST',
      headers: { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bug', text: 'x'.repeat(13 * 1024 * 1024) }),
    })
    expect(res.status).toBe(413)
  })

  it('turns away a member past the limit before reading the pictures', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await send([{ bytes: png(), type: 'image/png' }])).status).toBe(201)
    }
    const res = await send([{ bytes: png(), type: 'image/png' }])
    expect(res.status).toBe(429)
    expect(tracker.uploads).toHaveLength(10)
  })

  it('needs a signed-in session, not an access token', async () => {
    const created = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'cli' } })
    const { token } = await created.json()
    const form = new FormData()
    form.set('payload', JSON.stringify(payload))
    form.append('screenshot', new File([png() as Uint8Array<ArrayBuffer>], 'a.png'))
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(403)
    expect(tracker.uploads).toEqual([])
  })

  it('asks for the payload field in a multipart body', async () => {
    const form = new FormData()
    form.append('screenshot', new File([png() as Uint8Array<ArrayBuffer>], 'a.png'))
    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'x-hearth-dev-user': ALICE },
      body: form,
    })
    expect(res.status).toBe(400)
  })
})
