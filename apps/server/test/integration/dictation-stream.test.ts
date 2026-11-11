import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import {
  DictationSocketServer,
  WS_DICTATION_FAILED,
  WS_DICTATION_UNAUTHORIZED,
} from '../../src/dictation/index.js'
import { FakeLLM, FakeTranscriber } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { attachWebSocket } from '../../src/sync/index.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'

let root: string
let services: Services
let server: Server
let base: string
let llm: FakeLLM

beforeEach(async () => {
  root = await makeTempDir('hearth-dictation-stream-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  llm = new FakeLLM()
  services = createServices(config, { llm, transcriber: new FakeTranscriber() })
  await services.spaces.ensureTeamSpace()
  const app = new Hono()
  const inject = attachWebSocket(
    app,
    services.broadcaster,
    services.meetings.sockets,
    services.dictationSockets,
  )
  app.route('/', createApp(services))
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
  inject(server)
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

function token(email = ALICE): string {
  return services.dictation.store.createDevice({ userId: `dev:${email}`, email }, 'Mac').token
}

interface Outcome {
  messages: Array<Record<string, unknown>>
  close: { code: number; reason: string }
}

/** Opens /ws/dictation, runs `script` on the open socket, and resolves when the server closes it. */
async function stream(script: (ws: WebSocket) => void): Promise<Outcome> {
  const ws = new WebSocket(`ws://${base}/ws/dictation`)
  ws.binaryType = 'arraybuffer'
  const messages: Array<Record<string, unknown>> = []
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))))
  const close = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  )
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  script(ws)
  return { messages, close: await close }
}

/** `ms` of 16 kHz PCM16, in 100 ms frames. */
function frames(ms: number): Uint8Array[] {
  return Array.from({ length: ms / 100 }, () => new Uint8Array(3_200))
}

describe('/ws/dictation', () => {
  it('streams audio as it is spoken and answers finish with the cleaned result', async () => {
    const t = token()
    const { messages, close } = await stream((ws) => {
      ws.send(JSON.stringify({ type: 'start', token: t, mode: 'clean', app_name: 'Slack' }))
      // Sent straight away, before `ready`: held until the transcriber is up.
      for (const frame of frames(2_000)) ws.send(frame)
      ws.send(JSON.stringify({ type: 'finish' }))
    })
    expect(close.code).toBe(1000)
    expect(messages[0]).toEqual({ type: 'ready' })
    expect(messages[1]).toMatchObject({
      type: 'result',
      raw: 'me segment 1 me segment 2',
      cleaned: true,
      durationMs: 2_000,
    })
    expect(llm.calls[0]?.messages[0]?.content).toContain('The text goes into a chat app')
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(' '))
      .find((l) => l.startsWith('dictation {'))
    expect(logged).toContain('"via":"stream"')
    expect(logged).not.toContain('segment')
  })

  it('literal mode skips the model', async () => {
    const t = token()
    const { messages } = await stream((ws) => {
      ws.send(JSON.stringify({ type: 'start', token: t, mode: 'literal' }))
      for (const frame of frames(1_000)) ws.send(frame)
      ws.send(JSON.stringify({ type: 'finish' }))
    })
    expect(messages.at(-1)).toMatchObject({ type: 'result', text: 'me segment 1', cleaned: false })
    expect(llm.calls).toHaveLength(0)
  })

  it('refuses a bad or revoked token with 4401', async () => {
    const { messages, close } = await stream((ws) => {
      ws.send(JSON.stringify({ type: 'start', token: 'hdt_madeupmadeupmadeup' }))
    })
    expect(close.code).toBe(WS_DICTATION_UNAUTHORIZED)
    expect(messages).toEqual([expect.objectContaining({ type: 'error', code: 'unauthorized' })])

    const missing = await stream((ws) => ws.send(JSON.stringify({ type: 'finish' })))
    expect(missing.close.code).toBe(WS_DICTATION_UNAUTHORIZED)
  })

  it('cancel closes without a result or a model call', async () => {
    const t = token()
    const { messages, close } = await stream((ws) => {
      ws.send(JSON.stringify({ type: 'start', token: t }))
      for (const frame of frames(1_000)) ws.send(frame)
      ws.send(JSON.stringify({ type: 'cancel' }))
    })
    expect(close).toEqual({ code: 1000, reason: 'cancelled' })
    expect(messages.some((m) => m.type === 'result')).toBe(false)
    expect(llm.calls).toHaveLength(0)
  })

  it('refuses more than 10 minutes of audio', async () => {
    const t = token()
    const { messages, close } = await stream((ws) => {
      ws.send(JSON.stringify({ type: 'start', token: t }))
      const big = new Uint8Array(200_000)
      for (let i = 0; i < 100; i++) ws.send(big) // 20 MB: more than 10 minutes of 16 kHz PCM16
    })
    expect(close.code).toBe(WS_DICTATION_FAILED)
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'bad_request' })
  })

  it('ends a stream that goes quiet', async () => {
    const quiet = new DictationSocketServer({
      dictation: services.dictation,
      auth: services.auth,
      transcriber: new FakeTranscriber(),
      idleMs: 200,
    })
    const sent: string[] = []
    const closed = new Promise<number>((resolve) => {
      const handlers = quiet.connect({ send: (d) => sent.push(d), close: (code) => resolve(code) })
      handlers.text(JSON.stringify({ type: 'start', token: token() }))
      handlers.binary(new Uint8Array(3_200))
    })
    expect(await closed).toBe(WS_DICTATION_FAILED)
    expect(JSON.parse(sent.at(-1) ?? '{}')).toMatchObject({ type: 'error', code: 'asr_error' })
  })

  it('counts against the same 30 a minute as uploads', async () => {
    const t = token()
    const alice = await services.auth.principalForUser(`dev:${ALICE}`)
    if (!alice) throw new Error('no dev principal')
    for (let i = 0; i < 30; i++) services.dictation.takeSlot(alice)
    const { messages } = await stream((ws) => ws.send(JSON.stringify({ type: 'start', token: t })))
    expect(messages[0]).toMatchObject({ type: 'error', code: 'rate_limited' })
  })
})
