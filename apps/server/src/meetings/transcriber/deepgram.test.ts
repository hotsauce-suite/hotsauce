import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { HearthError } from '../../errors.js'
import { DeepgramTranscriber, listenUrl, segmentsFromMessage } from './deepgram.js'
import type { TranscriptSegment } from './types.js'

const STREAM: unknown[] = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/deepgram/stream.json', import.meta.url), 'utf8'),
)

/** The one segment a message maps to, or null; diarized finals are tested separately. */
function segmentFromMessage(message: unknown, track: 'me' | 'them', offsetMs: number) {
  const segments = segmentsFromMessage(message, track, offsetMs)
  expect(segments.length).toBeLessThanOrEqual(1)
  return segments[0] ?? null
}

/** A diarized Results message: words as [text, start s, end s, speaker]. */
function diarized(isFinal: boolean, words: Array<[string, number, number, number]>) {
  const start = words[0]?.[1] ?? 0
  const end = words[words.length - 1]?.[2] ?? 0
  return {
    type: 'Results',
    start,
    duration: end - start,
    is_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript: words.map((w) => w[0]).join(' '),
          words: words.map(([w, s, e, speaker]) => ({
            word: w.toLowerCase().replace(/[^a-z']/g, ''),
            punctuated_word: w,
            start: s,
            end: e,
            speaker,
          })),
        },
      ],
    },
  }
}

describe('segmentsFromMessage with speakers', () => {
  it('splits a final into one segment per run of the same speaker', () => {
    const message = diarized(true, [
      ['Can', 1.0, 1.2, 0],
      ['you', 1.2, 1.4, 0],
      ['ship?', 1.4, 1.8, 0],
      ['Yes,', 2.0, 2.3, 1],
      ['Friday.', 2.3, 2.9, 1],
    ])
    expect(segmentsFromMessage(message, 'them', 10_000)).toEqual([
      {
        track: 'them',
        speaker: 'Speaker 1',
        at: 11_000,
        durationMs: 800,
        text: 'Can you ship?',
        final: true,
      },
      {
        track: 'them',
        speaker: 'Speaker 2',
        at: 12_000,
        durationMs: 900,
        text: 'Yes, Friday.',
        final: true,
      },
    ])
  })

  it('keeps a one-speaker final whole, with its transcript text', () => {
    const message = diarized(true, [
      ['Sounds', 0.5, 0.8, 2],
      ['good.', 0.8, 1.1, 2],
    ])
    expect(segmentsFromMessage(message, 'them', 0)).toEqual([
      {
        track: 'them',
        speaker: 'Speaker 3',
        at: 500,
        durationMs: 600,
        text: 'Sounds good.',
        final: true,
      },
    ])
  })

  it('gives a partial its first word’s speaker and never splits it', () => {
    const message = diarized(false, [
      ['Can', 1.0, 1.2, 1],
      ['yes', 1.3, 1.5, 0],
    ])
    const segments = segmentsFromMessage(message, 'them', 0)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ speaker: 'Speaker 2', final: false, text: 'Can yes' })
  })

  it('falls back to the track label when the words carry no speaker', () => {
    const message = diarized(true, [['Hi.', 0, 0.3, 0]])
    const { speaker: _, ...word } = message.channel.alternatives[0]?.words[0] ?? { speaker: 0 }
    message.channel.alternatives = [{ transcript: 'Hi.', words: [word as never] }]
    expect(segmentsFromMessage(message, 'them', 0)[0]?.speaker).toBe('Them')
  })
})

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
    expect(url.searchParams.has('diarize')).toBe(false)
  })

  it('asks for speakers only when told to', () => {
    const url = new URL(listenUrl('wss://x/v1/listen', { model: 'nova-3', diarize: true }))
    expect(url.searchParams.get('diarize')).toBe('true')
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
    // The call's side is diarized.
    expect(url.searchParams.get('diarize')).toBe('true')
  })

  it('diarizes the call’s side only, never the microphone or a dictation', async () => {
    fake = await FakeDeepgram.start()
    fake.reply = []
    const transcriber = new DeepgramTranscriber({ apiKey: 'k', url: fake.url })
    const meeting = await transcriber.start({ sessionId: 's-d' })
    meeting.sendAudio('me', FRAME)
    meeting.sendAudio('them', FRAME)
    await vi.waitFor(() => expect(fake?.requests).toHaveLength(2))
    const dictation = await transcriber.start({ sessionId: 's-dict', failOnDrop: true })
    dictation.sendAudio('them', FRAME)
    await vi.waitFor(() => expect(fake?.requests).toHaveLength(3))
    const diarize = fake.requests.map((r) =>
      new URL(r.url ?? '', 'ws://x').searchParams.get('diarize'),
    )
    // Connection order between the two tracks isn't fixed.
    expect([...diarize.slice(0, 2)].sort()).toEqual([null, 'true'].sort())
    expect(diarize[2]).toBeNull()
    await Promise.all([meeting.finish(), dictation.finish()])
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
