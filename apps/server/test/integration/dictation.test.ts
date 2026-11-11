import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { type Config, loadConfig } from '../../src/config.js'
import { FakeDictationTranscriber } from '../../src/dictation/index.js'
import { HearthError } from '../../src/errors.js'
import { FakeLLM, type LLMRequest, wavHeader } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let config: Config
let services: Services
let app: ReturnType<typeof createApp>
let asr: FakeDictationTranscriber
let respond: (req: LLMRequest) => string
let llm: FakeLLM

beforeEach(async () => {
  root = await makeTempDir('hearth-dictation-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  asr = new FakeDictationTranscriber()
  respond = () => '<cleaned>So this is a fake dictation of 1.5 seconds.</cleaned>'
  llm = new FakeLLM((req) => respond(req))
  services = createServices(config, { llm, dictationTranscriber: asr })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

function wav(ms: number): Uint8Array {
  const pcm = new Uint8Array(ms * 32)
  const out = new Uint8Array(44 + pcm.length)
  out.set(wavHeader(pcm.length), 0)
  out.set(pcm, 44)
  return out
}

interface Options {
  as?: string
  token?: string
  json?: unknown
  body?: Uint8Array
  type?: string
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  if (opts.type) headers['content-type'] = opts.type
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
  return app.request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: body as BodyInit } : {}),
  })
}

async function json<T = unknown>(res: Response, status = 200): Promise<T> {
  const text = await res.text()
  expect(res.status, text).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

async function connect(as = ALICE): Promise<{ id: string; token: string }> {
  return json(await call('POST', '/api/dictation/devices', { as, json: { name: 'Test Mac' } }), 201)
}

describe('POST /api/dictation/transcribe', () => {
  it('transcribes a WAV and cleans it, with the member’s and team’s words', async () => {
    await json(
      await call('PUT', '/api/dictation/words', {
        as: ALICE,
        json: { scope: 'mine', words: ['Zorblax'] },
      }),
    )
    const res = await call(
      'POST',
      '/api/dictation/transcribe?mode=clean&app_name=Slack&app_bundle=com.tinyspeck.slackmacgap',
      {
        as: ALICE,
        type: 'audio/wav',
        body: wav(1500),
      },
    )
    const body = await json<Record<string, unknown>>(res)
    expect(body).toMatchObject({
      text: 'So this is a fake dictation of 1.5 seconds.',
      raw: 'um so this is a fake dictation, uh, of 1.5 seconds',
      cleaned: true,
      durationMs: 1500,
    })
    expect(body.ms).toEqual({ asr: expect.any(Number), llm: expect.any(Number) })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(asr.calls[0]?.keyterms).toEqual([
      'Zorblax',
      'Hotsauce',
      'Clerk',
      'Deepgram',
      'Anthropic',
      'Claude',
    ])
    expect(asr.calls[0]?.mimeType).toBe('audio/wav')
    const prompt = llm.calls[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('The text goes into a chat app')
    expect(prompt).toContain('Zorblax, Hotsauce')
    expect(llm.calls[0]?.model).toBe('claude-haiku-5-5')
  })

  it('skips the model in literal mode', async () => {
    const body = await json(
      await call('POST', '/api/dictation/transcribe?mode=literal', {
        as: ALICE,
        type: 'audio/wav',
        body: wav(500),
      }),
    )
    expect(body).toMatchObject({
      text: 'um so this is a fake dictation, uh, of 0.5 seconds',
      cleaned: false,
      ms: { llm: 0 },
    })
    expect(llm.calls).toHaveLength(0)
  })

  it('returns the raw transcript when the model fails', async () => {
    respond = () => {
      throw new HearthError('llm_error', 'busy')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/wav',
        body: wav(500),
      }),
    )
    expect(body).toMatchObject({
      text: 'um so this is a fake dictation, uh, of 0.5 seconds',
      cleaned: false,
    })
  })

  it('never logs the transcript', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    respond = () => {
      throw new HearthError('llm_error', 'busy')
    }
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/wav',
        body: wav(500),
      }),
    )
    for (const spy of spies) {
      for (const args of spy.mock.calls) expect(args.join(' ')).not.toContain('fake dictation')
    }
  })

  it('accepts mp4 and webm, and refuses other types, empty bodies and over-long WAVs', async () => {
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/mp4',
        body: new Uint8Array(3200),
      }),
    )
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/webm;codecs=opus',
        body: new Uint8Array(3200),
      }),
    )
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'text/plain',
        body: new Uint8Array(10),
      }),
      415,
    )
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/wav',
        body: new Uint8Array(0),
      }),
      400,
    )
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/wav',
        body: new Uint8Array(100),
      }),
      400,
    )
    // 8 kHz mono 8-bit: 11 minutes in 5.3 MB, so the duration limit bites before the size one.
    const long = wav(1)
    const view = new DataView(long.buffer)
    const dataBytes = 11 * 60 * 8000
    const big = new Uint8Array(44 + dataBytes)
    big.set(long.subarray(0, 44), 0)
    const bigView = new DataView(big.buffer)
    bigView.setUint32(24, 8000, true) // sample rate
    bigView.setUint32(28, 8000, true) // byte rate
    bigView.setUint16(32, 1, true) // block align
    bigView.setUint16(34, 8, true) // bits per sample
    bigView.setUint32(40, dataBytes, true)
    expect(view.getUint32(24, true)).toBe(16000)
    await json(
      await call('POST', '/api/dictation/transcribe', { as: ALICE, type: 'audio/wav', body: big }),
      413,
    )
    await json(
      await call('POST', '/api/dictation/transcribe', {
        as: ALICE,
        type: 'audio/wav',
        body: new Uint8Array(16 * 1024 * 1024),
      }),
      413,
    )
  })

  it('needs a session or a device token', async () => {
    await json(
      await call('POST', '/api/dictation/transcribe', { type: 'audio/wav', body: wav(100) }),
      401,
    )
  })

  it('limits each member to 30 a minute', async () => {
    for (let i = 0; i < 30; i++) {
      await json(
        await call('POST', '/api/dictation/transcribe?mode=literal', {
          as: ALICE,
          type: 'audio/wav',
          body: wav(10),
        }),
      )
    }
    const refused = await json<{ error: { code: string } }>(
      await call('POST', '/api/dictation/transcribe?mode=literal', {
        as: ALICE,
        type: 'audio/wav',
        body: wav(10),
      }),
      429,
    )
    expect(refused.error.code).toBe('rate_limited')
    await json(
      await call('POST', '/api/dictation/transcribe?mode=literal', {
        as: BOB,
        type: 'audio/wav',
        body: wav(10),
      }),
    )
  })
})

describe('device tokens', () => {
  it('dictate and read the words, and do nothing else in Hearth', async () => {
    const { token } = await connect()
    expect(token).toMatch(/^hdt_/)
    const body = await json(
      await call('POST', '/api/dictation/transcribe', { token, type: 'audio/wav', body: wav(200) }),
    )
    expect(body).toMatchObject({ cleaned: true })
    expect(await json(await call('GET', '/api/dictation/words', { token }))).toMatchObject({
      mine: [],
      team: expect.arrayContaining(['Hotsauce']),
    })

    const refused: Array<[string, string, Options?]> = [
      ['GET', '/api/me'],
      ['GET', '/api/spaces/team/tree'],
      ['GET', '/api/spaces/alice/file?path=README.md'],
      ['GET', '/api/search?q=hello'],
      ['GET', '/api/meetings'],
      ['GET', '/api/dictation/devices'],
      ['POST', '/api/dictation/devices', { json: { name: 'another' } }],
      ['POST', '/api/dictation/words', { json: { scope: 'team', words: ['x'] } }],
      ['DELETE', '/api/dictation/words'],
      ['GET', '/api/dictation/transcribe'],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens', { json: { name: 'agent' } }],
      ['POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }],
    ]
    for (const [method, url, opts] of refused) {
      const res = await call(method, url, { ...opts, token })
      expect(res.status, `${method} ${url}`).toBe(401)
    }
    // A dev header beside the token doesn't widen what the request can do.
    const both = await app.request('/api/me', {
      headers: { authorization: `Bearer ${token}`, 'x-hearth-dev-user': ALICE },
    })
    expect(both.status).toBe(401)
  })

  it('edit the member’s own words and the team’s, like the web page', async () => {
    const { token } = await connect()
    await json(
      await call('PUT', '/api/dictation/words', {
        token,
        json: { scope: 'mine', words: ['Zorblax'] },
      }),
    )
    await json(
      await call('PUT', '/api/dictation/words', {
        token,
        json: { scope: 'team', words: ['Acme', 'Kestrel'] },
      }),
    )
    expect(await json(await call('GET', '/api/dictation/words', { as: ALICE }))).toMatchObject({
      mine: ['Zorblax'],
      team: ['Acme', 'Kestrel'],
    })
    expect(await json(await call('GET', '/api/dictation/words', { as: BOB }))).toMatchObject({
      mine: [],
      team: ['Acme', 'Kestrel'],
    })
  })

  it('add and remove against the current list, so concurrent edits keep each other', async () => {
    const { token } = await connect()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Bob adds on the web while Alice's Mac still shows the old list.
    await json(
      await call('PUT', '/api/dictation/words', {
        as: BOB,
        json: { scope: 'team', words: ['Acme', 'Kestrel'] },
      }),
    )
    const added = await json<{ words: string[] }>(
      await call('PUT', '/api/dictation/words', {
        token,
        json: { scope: 'team', add: ['Zorblax', 'zorblax'] },
      }),
    )
    expect(added.words).toEqual(['Acme', 'Kestrel', 'Zorblax'])
    const removed = await json<{ words: string[] }>(
      await call('PUT', '/api/dictation/words', {
        token,
        json: { scope: 'team', remove: ['ACME'] },
      }),
    )
    expect(removed.words).toEqual(['Kestrel', 'Zorblax'])
  })

  it('can disconnect themselves, and only themselves', async () => {
    const one = await connect()
    const two = await connect()
    await json(await call('DELETE', '/api/dictation/devices/self', { as: ALICE }), 400)
    await json(await call('DELETE', '/api/dictation/devices/self', { token: one.token }), 204)
    await json(await call('GET', '/api/dictation/words', { token: one.token }), 401)
    await json(await call('GET', '/api/dictation/words', { token: two.token }))
    await json(await call('DELETE', `/api/dictation/devices/${two.id}`, { token: one.token }), 401)
    await json(await call('DELETE', `/api/dictation/devices/${two.id}`, { token: two.token }), 401)
  })

  it('stop working once revoked, and only the owner can revoke', async () => {
    const { id, token } = await connect()
    const list = await json<Array<{ id: string; name: string; lastUsedAt: string | null }>>(
      await call('GET', '/api/dictation/devices', { as: ALICE }),
    )
    expect(list).toEqual([
      { id, name: 'Test Mac', createdAt: expect.any(String), lastUsedAt: null },
    ])
    expect(JSON.stringify(list)).not.toContain('hdt_')
    await json(await call('GET', '/api/dictation/words', { token }))
    const used = await json<Array<{ lastUsedAt: string | null }>>(
      await call('GET', '/api/dictation/devices', { as: ALICE }),
    )
    expect(used[0]?.lastUsedAt).not.toBeNull()

    await json(await call('DELETE', `/api/dictation/devices/${id}`, { as: BOB }), 404)
    expect(await json(await call('GET', '/api/dictation/devices', { as: BOB }))).toEqual([])
    await json(await call('DELETE', `/api/dictation/devices/${id}`, { as: ALICE }), 204)
    await json(
      await call('POST', '/api/dictation/transcribe', { token, type: 'audio/wav', body: wav(200) }),
      401,
    )
    await json(await call('GET', '/api/dictation/words', { token }), 401)
    await json(await call('GET', '/api/dictation/words', { token: 'hdt_madeup' }), 401)
  })

  it('are refused, and revoked, once the domain lock refuses their member', async () => {
    const { token } = services.dictation.store.createDevice(
      { userId: 'dev:eve@elsewhere.com', email: 'eve@elsewhere.com' },
      'Eve’s Mac',
    )
    const res = await json<{ error: { code: string } }>(
      await call('GET', '/api/dictation/words', { token }),
      403,
    )
    expect(res.error.code).toBe('domain_not_allowed')
    expect(services.dictation.store.useToken(token)).toBeNull()
  })

  it('are refused, and revoked, when the account is gone', async () => {
    const { token } = await connect()
    vi.spyOn(services.auth, 'principalForUser').mockResolvedValueOnce(null)
    await json(await call('GET', '/api/dictation/words', { token }), 401)
    await json(await call('GET', '/api/dictation/words', { token }), 401)
  })

  it('aren’t accepted on the document WebSocket either', async () => {
    const { token } = await connect()
    const req = new Request('http://localhost/ws', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await services.auth.authenticate(req)).toBeNull()
  })
})

describe('word lists', () => {
  it('keep mine private and share the team list', async () => {
    expect(await json(await call('GET', '/api/dictation/words', { as: ALICE }))).toEqual({
      account: ALICE,
      mine: [],
      team: ['Hotsauce', 'Clerk', 'Deepgram', 'Anthropic', 'Claude'],
    })
    expect(
      await json(
        await call('PUT', '/api/dictation/words', {
          as: ALICE,
          json: { scope: 'mine', words: [' Kubernetes ', 'kubernetes', 'Fly.io'] },
        }),
      ),
    ).toEqual({
      scope: 'mine',
      words: ['Kubernetes', 'Fly.io'],
    })
    await json(
      await call('PUT', '/api/dictation/words', {
        as: ALICE,
        json: { scope: 'team', words: ['Acme', 'Biosafety'] },
      }),
    )
    expect(await json(await call('GET', '/api/dictation/words', { as: BOB }))).toEqual({
      account: BOB,
      mine: [],
      team: ['Acme', 'Biosafety'],
    })
    await json(
      await call('PUT', '/api/dictation/words', {
        as: ALICE,
        json: { scope: 'mine', words: ['a\nb'] },
      }),
      400,
    )
    await json(
      await call('PUT', '/api/dictation/words', {
        as: ALICE,
        json: { scope: 'mine', words: ['x'.repeat(61)] },
      }),
      400,
    )
  })
})
