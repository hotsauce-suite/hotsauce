import WebSocket from 'ws'
import { z } from 'zod'
import { HearthError } from '../../errors.js'
import { SessionEvents } from './events.js'
import {
  PCM_BYTES_PER_MS,
  speakerFor,
  TRACKS,
  type Track,
  type Transcriber,
  type TranscriberSession,
  type TranscriptSegment,
} from './types.js'

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen'
// Deepgram closes a stream that has had no audio for about 10 s (a pause, a muted tab).
const KEEP_ALIVE_MS = 5_000
const FINISH_TIMEOUT_MS = 10_000
// After a dropped or refused connection, wait this long before trying again.
const RETRY_MS = 2_000
// Audio held while disconnected: 30 s. Older audio goes untranscribed (it is still on disk).
const MAX_QUEUED_BYTES = 30_000 * PCM_BYTES_PER_MS

const Results = z.object({
  type: z.literal('Results'),
  start: z.number(),
  duration: z.number(),
  is_final: z.boolean(),
  channel: z.object({
    alternatives: z.array(z.object({ transcript: z.string() })),
  }),
})

/**
 * One Deepgram `Results` message as a segment, or null for anything else (Metadata,
 * SpeechStarted, UtteranceEnd) and for empty transcripts. `offsetMs` is the audio on the track
 * before this connection opened, since each connection's `start` counts from its own zero.
 */
export function segmentFromMessage(
  message: unknown,
  track: Track,
  offsetMs: number,
): TranscriptSegment | null {
  const parsed = Results.safeParse(message)
  if (!parsed.success) return null
  const text = parsed.data.channel.alternatives[0]?.transcript.trim() ?? ''
  if (text === '') return null
  return {
    track,
    speaker: speakerFor(track),
    at: offsetMs + Math.round(parsed.data.start * 1000),
    durationMs: Math.round(parsed.data.duration * 1000),
    text,
    final: parsed.data.is_final,
  }
}

/** The streaming URL for one track (ARCHITECTURE §7.1). Nova-3 takes custom words as `keyterm`. */
export function listenUrl(
  base: string,
  opts: { model: string; language?: string | undefined; vocabulary?: string[] | undefined },
): string {
  const url = new URL(base)
  const params = url.searchParams
  params.set('encoding', 'linear16')
  params.set('sample_rate', '16000')
  params.set('channels', '1')
  params.set('interim_results', 'true')
  params.set('smart_format', 'true')
  params.set('model', opts.model)
  if (opts.language) params.set('language', opts.language)
  for (const term of opts.vocabulary ?? []) params.append('keyterm', term)
  return url.href
}

export interface DeepgramOptions {
  apiKey: string
  /** Tests point this at a local fake server. */
  url?: string
  model?: string
  keepAliveMs?: number
  retryMs?: number
  log?: (message: string) => void
}

/** Streams each track to Deepgram over its own WebSocket. Never called in tests. */
export class DeepgramTranscriber implements Transcriber {
  readonly #opts: Required<Omit<DeepgramOptions, 'log'>> & { log: (message: string) => void }

  constructor(opts: DeepgramOptions) {
    this.#opts = {
      apiKey: opts.apiKey,
      url: opts.url ?? DEEPGRAM_URL,
      model: opts.model ?? 'nova-3',
      keepAliveMs: opts.keepAliveMs ?? KEEP_ALIVE_MS,
      retryMs: opts.retryMs ?? RETRY_MS,
      log: opts.log ?? console.error,
    }
  }

  async start(opts: {
    sessionId: string
    language?: string
    vocabulary?: string[]
    failOnDrop?: boolean
  }): Promise<TranscriberSession> {
    const url = listenUrl(this.#opts.url, {
      model: this.#opts.model,
      language: opts.language,
      vocabulary: opts.vocabulary,
    })
    const { apiKey, keepAliveMs, retryMs, log } = this.#opts
    return new DeepgramSession({
      apiKey,
      url,
      keepAliveMs,
      retryMs,
      log,
      sessionId: opts.sessionId,
      failOnDrop: opts.failOnDrop ?? false,
    })
  }
}

interface SessionConfig {
  apiKey: string
  url: string
  keepAliveMs: number
  retryMs: number
  sessionId: string
  log: (message: string) => void
  /** A connection Deepgram drops before finish() is an error, not a reconnect (dictation). */
  failOnDrop: boolean
}

class DeepgramSession implements TranscriberSession {
  readonly #events = new SessionEvents()
  readonly #tracks: Record<Track, TrackStream>
  #finished = false
  readonly on: TranscriberSession['on']

  constructor(config: SessionConfig) {
    this.on = this.#events.on
    const deliver = (seg: TranscriptSegment) => {
      if (!this.#finished) this.#events.segment(seg)
    }
    const fail = (err: Error) => {
      if (!this.#finished) this.#events.error(err)
    }
    this.#tracks = {
      me: new TrackStream('me', config, deliver, fail),
      them: new TrackStream('them', config, deliver, fail),
    }
  }

  sendAudio(track: Track, pcm16: Uint8Array): void {
    if (!this.#finished) this.#tracks[track].send(pcm16)
  }

  async finish(): Promise<void> {
    if (this.#finished) return
    await Promise.all(TRACKS.map((track) => this.#tracks[track].finish()))
    this.#finished = true
    this.#events.clear()
  }
}

/**
 * One track's stream. The connection opens on the first audio and, if Deepgram drops it, reopens
 * on later audio after `retryMs`; audio sent meanwhile is queued, up to MAX_QUEUED_BYTES.
 */
class TrackStream {
  readonly #track: Track
  readonly #config: SessionConfig
  readonly #deliver: (seg: TranscriptSegment) => void
  readonly #fail: (err: Error) => void
  #ws: WebSocket | null = null
  #queue: Uint8Array[] = []
  #queuedBytes = 0
  #retryAt = 0
  #bytesSent = 0
  /** Audio on this track before the current connection opened. */
  #offsetMs = 0
  #lastSentAt = 0
  #keepAlive: ReturnType<typeof setInterval> | null = null
  #finishing = false

  constructor(
    track: Track,
    config: SessionConfig,
    deliver: (seg: TranscriptSegment) => void,
    fail: (err: Error) => void,
  ) {
    this.#track = track
    this.#config = config
    this.#deliver = deliver
    this.#fail = fail
  }

  send(pcm16: Uint8Array): void {
    if (this.#ws === null && Date.now() >= this.#retryAt) this.#connect()
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#write(pcm16)
      return
    }
    this.#queue.push(pcm16)
    this.#queuedBytes += pcm16.length
    while (this.#queuedBytes > MAX_QUEUED_BYTES) {
      const dropped = this.#queue.shift()
      this.#queuedBytes -= dropped?.length ?? 0
      // Skipped audio still counts towards the track's timeline.
      this.#bytesSent += dropped?.length ?? 0
    }
  }

  /** Asks Deepgram to flush (CloseStream) and waits for it to close the connection. */
  finish(): Promise<void> {
    this.#finishing = true
    // Audio queued while waiting to reconnect would otherwise never be heard; the open handler
    // sends it before CloseStream goes.
    if (this.#ws === null && this.#queue.length > 0) this.#connect()
    const ws = this.#ws
    if (ws === null) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#config.log(`deepgram ${this.#config.sessionId}/${this.#track}: no close after flush`)
        ws.terminate()
      }, FINISH_TIMEOUT_MS)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      const closeStream = () => ws.send(JSON.stringify({ type: 'CloseStream' }))
      if (ws.readyState === WebSocket.OPEN) closeStream()
      else if (ws.readyState === WebSocket.CONNECTING) ws.once('open', closeStream)
      else ws.terminate()
    })
  }

  #connect(): void {
    const ws = new WebSocket(this.#config.url, {
      headers: { Authorization: `Token ${this.#config.apiKey}` },
    })
    this.#ws = ws
    this.#offsetMs = Math.floor(this.#bytesSent / PCM_BYTES_PER_MS)
    const offsetMs = this.#offsetMs
    ws.on('open', () => {
      const queued = this.#queue
      this.#queue = []
      this.#queuedBytes = 0
      for (const pcm of queued) this.#write(pcm)
      this.#keepAlive = setInterval(() => this.#keepAliveTick(ws), this.#config.keepAliveMs)
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let message: unknown
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      const segment = segmentFromMessage(message, this.#track, offsetMs)
      if (segment) this.#deliver(segment)
    })
    ws.on('error', (err) => {
      // The detail (status, network cause) can name the account; it stays in the server log.
      this.#config.log(`deepgram ${this.#config.sessionId}/${this.#track}: ${err.message}`)
      this.#fail(new HearthError('asr_error', 'Live transcription failed; audio is still saved'))
    })
    ws.on('close', (code) => {
      if (this.#keepAlive) clearInterval(this.#keepAlive)
      this.#keepAlive = null
      if (this.#ws === ws) this.#ws = null
      this.#retryAt = Date.now() + this.#config.retryMs
      // Words in flight on the dropped connection are gone: for a dictation, say so, so the
      // whole recording is sent again rather than a transcript with a hole in it.
      if (this.#config.failOnDrop && !this.#finishing) {
        this.#config.log(`deepgram ${this.#config.sessionId}/${this.#track}: dropped (${code})`)
        this.#fail(new HearthError('asr_error', 'Live transcription dropped'))
      }
    })
  }

  #write(pcm16: Uint8Array): void {
    this.#ws?.send(pcm16)
    this.#bytesSent += pcm16.length
    this.#lastSentAt = Date.now()
  }

  #keepAliveTick(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.#lastSentAt >= this.#config.keepAliveMs) {
      ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }
  }
}
