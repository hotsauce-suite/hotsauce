import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { HearthError } from '../../errors.js'
import { DeepgramTranscriber, listenUrl, segmentFromMessage } from './deepgram.js'
import type { TranscriptSegment } from './types.js'

const STREAM: unknown[] = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/deepgram/stream.json', import.meta.url), 'utf8'),
)

describe('segmentFromMessage', () => {
  it('maps Results to segments and skips everything else', () => {
    const segments = STREAM.map((m) => segmentFromMessage(m, 'them', 0))
    expect(segments).toEqual([
      null, // SpeechStarted
      {
        track: 'them',
        speaker: 'Them',
        at: 480,
        durationMs: 1020,
        text: "we'd need",
        final: false,
      },
      {
        track: 'them',
        speaker: 'Them',
        at: 480,
        durationMs: 2400,
        text: "We'd need SSO before rolling out.",
        final: true,
      },
      null, // an empty final
      null, // UtteranceEnd
      {
        track: 'them',
        speaker: 'Them',
        at: 3980,
        durationMs: 1500,
        text: 'Pricing by Friday works.',
        final: true,
      },
      null, // Metadata
    ])
  })

  it('adds the audio heard before the connection opened', () => {
    expect(segmentFromMessage(STREAM[2], 'me', 60_000)).toMatchObject({
      track: 'me',
      speaker: 'Me',
      at: 60_480,
    })
  })

  it('ignores malformed messages', () => {
    for (const message of [null, 'Results', { type: 'Results' }, { type: 'Results', start: '1' }]) {
      expect(segmentFromMessage(message, 'me', 0)).toBeNull()
    }
  })
})

describe('listenUrl', () => {
  it('asks for 16 kHz linear PCM, interim results and smart formatting', () => {
    const url = new URL(
      listenUrl('wss://api.deepgram.com/v1/listen', {
        model: 'nova-3',
        language: 'en',
        vocabulary: ['Hearth', 'Acme'],
      }),
    )
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      model: 'nova-3',
      language: 'en',
    })
    expect(url.searchParams.getAll('keyterm')).toEqual(['Hearth', 'Acme'])
  })
})

/** A local stand-in for Deepgram's streaming endpoint. Never the real service. */
class FakeDeepgram {
  readonly server: WebSocketServer
  readonly requests: IncomingMessage[] = []
  readonly sockets: WebSocket[] = []
  readonly audio: number[] = []
  readonly control: string[] = []
  /** What to send back after each connection's first audio frame. */
  reply: unknown[] = STREAM.slice(0, 3)
  /** What to send back on CloseStream, before closing. */
  flush: unknown[] = STREAM.slice(5)

  private constructor(server: WebSocketServer) {
    this.server = server
    server.on('connection', (ws, req) => {
      this.requests.push(req)
      this.sockets.push(ws)
      const index = this.audio.push(0) - 1
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          if (this.audio[index] === 0) for (const m of this.reply) ws.send(JSON.stringify(m))
          this.audio[index] = (this.audio[index] ?? 0) + (data as Buffer).length
          return
        }
        const text = data.toString()
        this.control.push(text)
        if (JSON.parse(text).type === 'CloseStream') {
          for (const m of this.flush) ws.send(JSON.stringify(m))
          ws.close(1000)
        }
      })
    })
  }

  static async start(opts: { verifyClient?: () => boolean } = {}): Promise<FakeDeepgram> {
    const server = new WebSocketServer({
      port: 0,
      ...(opts.verifyClient ? { verifyClient: opts.verifyClient } : {}),
    })
    await new Promise((resolve) => server.once('listening', resolve))
    return new FakeDeepgram(server)
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/listen`
  }

  close(): Promise<void> {
    for (const ws of this.server.clients) ws.terminate()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

let fake: FakeDeepgram | null = null
afterEach(async () => {
  await fake?.close()
  fake = null
})

const FRAME = new Uint8Array(3_200)

describe('DeepgramTranscriber against a fake server', () => {
  it('streams a track with the token, maps results, and flushes with CloseStream', async () => {
    fake = await FakeDeepgram.start()
    const transcriber = new DeepgramTranscriber({ apiKey: 'dg-key', url: fake.url })
    const session = await transcriber.start({ sessionId: 's1', vocabulary: ['SSO'] })
    const segments: TranscriptSegment[] = []
    session.on('segment', (seg) => segments.push(seg))

    for (let i = 0; i < 10; i++) session.sendAudio('them', FRAME)
    await vi.waitFor(() => expect(segments).toHaveLength(2))
    await session.finish()

    const request = fake.requests[0]
    expect(request?.headers.authorization).toBe('Token dg-key')
    const url = new URL(request?.url ?? '', 'ws://x')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('keyterm')).toBe('SSO')
    expect(fake.audio).toEqual([32_000])
    expect(fake.control).toEqual([JSON.stringify({ type: 'CloseStream' })])
    expect(segments.map((s) => [s.track, s.speaker, s.at, s.final, s.text])).toEqual([
      ['them', 'Them', 480, false, "we'd need"],
      ['them', 'Them', 480, true, "We'd need SSO before rolling out."],
      ['them', 'Them', 3980, true, 'Pricing by Friday works.'],
    ])
    // One connection per track; `me` sent nothing, so it never connected.
    expect(fake.requests).toHaveLength(1)
  })

  it('reconnects after a drop and offsets the new connection by the audio already sent', async () => {
    fake = await FakeDeepgram.start()
    const transcriber = new DeepgramTranscriber({ apiKey: 'k', url: fake.url, retryMs: 0 })
    const session = await transcriber.start({ sessionId: 's2' })
    const segments: TranscriptSegment[] = []
    session.on('segment', (seg) => segments.push(seg))

    for (let i = 0; i < 20; i++) session.sendAudio('me', FRAME) // 2 s
    await vi.waitFor(() => expect(fake?.audio[0]).toBe(64_000))
    fake.sockets[0]?.close(1011)
    await vi.waitFor(() => expect(fake?.sockets[0]?.readyState).toBe(3))
    await new Promise((resolve) => setTimeout(resolve, 20))

    session.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(fake?.requests).toHaveLength(2))
    await vi.waitFor(() => expect(segments.filter((s) => s.at >= 2000)).toHaveLength(2))
    expect(segments.filter((s) => s.at >= 2000).map((s) => s.at)).toEqual([2480, 2480])
    await session.finish()
  })

  it('with failOnDrop (dictation), a drop is an error, not a reconnect; a finish is not a drop', async () => {
    fake = await FakeDeepgram.start()
    const log = vi.fn()
    const transcriber = new DeepgramTranscriber({ apiKey: 'k', url: fake.url, retryMs: 0, log })
    const dropped = await transcriber.start({ sessionId: 's6', failOnDrop: true })
    const errors: Error[] = []
    dropped.on('error', (err) => errors.push(err))
    dropped.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(fake?.audio[0]).toBe(3_200))
    fake.sockets[0]?.close(1011)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ code: 'asr_error' })

    const finished = await transcriber.start({ sessionId: 's7', failOnDrop: true })
    const finishErrors: Error[] = []
    finished.on('error', (err) => finishErrors.push(err))
    finished.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(fake?.audio[1]).toBe(3_200))
    await finished.finish()
    expect(finishErrors).toEqual([])
  })

  it('on finish, sends audio queued while waiting to reconnect before flushing', async () => {
    fake = await FakeDeepgram.start()
    const transcriber = new DeepgramTranscriber({ apiKey: 'k', url: fake.url, retryMs: 60_000 })
    const session = await transcriber.start({ sessionId: 's5' })
    session.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(fake?.audio[0]).toBe(3_200))
    fake.sockets[0]?.close(1011)
    await vi.waitFor(() => expect(fake?.sockets[0]?.readyState).toBe(3))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Within the retry delay: queued, not sent.
    session.sendAudio('me', FRAME)
    session.sendAudio('me', FRAME)
    expect(fake.requests).toHaveLength(1)
    await session.finish()

    expect(fake.requests).toHaveLength(2)
    expect(fake.audio[1]).toBe(6_400)
    expect(fake.control).toEqual([JSON.stringify({ type: 'CloseStream' })])
  })

  it('keeps an idle stream alive', async () => {
    fake = await FakeDeepgram.start()
    const transcriber = new DeepgramTranscriber({ apiKey: 'k', url: fake.url, keepAliveMs: 10 })
    const session = await transcriber.start({ sessionId: 's3' })
    session.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(fake?.control).toContain(JSON.stringify({ type: 'KeepAlive' })))
    await session.finish()
  })

  it('reports a refused connection as asr_error and logs the detail', async () => {
    fake = await FakeDeepgram.start({ verifyClient: () => false })
    const log = vi.fn()
    const transcriber = new DeepgramTranscriber({ apiKey: 'bad', url: fake.url, log })
    const session = await transcriber.start({ sessionId: 's4' })
    const errors: Error[] = []
    session.on('error', (err) => errors.push(err))

    session.sendAudio('me', FRAME)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toBeInstanceOf(HearthError)
    expect((errors[0] as HearthError).code).toBe('asr_error')
    expect(log.mock.calls[0]?.[0]).toMatch(/^deepgram s4\/me: Unexpected server response: 401/)
    await session.finish()
  })
})
