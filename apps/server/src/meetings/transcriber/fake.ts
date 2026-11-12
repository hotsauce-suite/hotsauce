import { SessionEvents } from './events.js'
import {
  PCM_BYTES_PER_MS,
  speakerFor,
  type Track,
  type Transcriber,
  type TranscriberSession,
} from './types.js'

/**
 * Deterministic stand-in for a real ASR service (ASR_PROVIDER=fake, the default in development
 * and test). Every `bytesPerSegment` of audio on a track (default 32,000 bytes, one second) is
 * one final segment, "<track> segment <n>"; with `partials`, a partial of the same text comes
 * when the segment is half heard. `finish()` flushes what's left as a shorter final segment.
 * With `speakers`, the call's side is "diarized": its segments take turns as "Speaker 1",
 * "Speaker 2"… up to that many, as Deepgram labels them.
 */
export class FakeTranscriber implements Transcriber {
  readonly #bytesPerSegment: number
  readonly #partials: boolean
  readonly #speakers: number
  /** Session ids, in the order they were started. */
  readonly started: string[] = []

  constructor(opts: { bytesPerSegment?: number; partials?: boolean; speakers?: number } = {}) {
    this.#bytesPerSegment = opts.bytesPerSegment ?? 32_000
    this.#partials = opts.partials ?? false
    this.#speakers = opts.speakers ?? 0
  }

  async start(opts: { sessionId: string }): Promise<TranscriberSession> {
    this.started.push(opts.sessionId)
    return new FakeTranscriberSession(this.#bytesPerSegment, this.#partials, this.#speakers)
  }
}

class FakeTranscriberSession implements TranscriberSession {
  readonly #events = new SessionEvents()
  readonly #bytesPerSegment: number
  readonly #partials: boolean
  readonly #speakers: number
  readonly #bytes: Record<Track, number> = { me: 0, them: 0 }
  /** Bytes already turned into final segments. */
  readonly #done: Record<Track, number> = { me: 0, them: 0 }
  readonly #partialSent: Record<Track, boolean> = { me: false, them: false }
  readonly #count: Record<Track, number> = { me: 0, them: 0 }
  #finished = false

  readonly on: TranscriberSession['on']

  constructor(bytesPerSegment: number, partials: boolean, speakers: number) {
    this.#bytesPerSegment = bytesPerSegment
    this.#partials = partials
    this.#speakers = speakers
    this.on = this.#events.on
  }

  sendAudio(track: Track, pcm16: Uint8Array): void {
    if (this.#finished) return
    this.#bytes[track] += pcm16.length
    for (;;) {
      const heard = this.#bytes[track] - this.#done[track]
      if (this.#partials && !this.#partialSent[track] && heard * 2 >= this.#bytesPerSegment) {
        this.#partialSent[track] = true
        this.#emit(track, this.#bytesPerSegment, false)
      }
      if (heard < this.#bytesPerSegment) return
      this.#emit(track, this.#bytesPerSegment, true)
    }
  }

  async finish(): Promise<void> {
    if (this.#finished) return
    for (const track of ['me', 'them'] as const) {
      const rest = this.#bytes[track] - this.#done[track]
      if (rest > 0) this.#emit(track, rest, true)
    }
    this.#finished = true
    this.#events.clear()
  }

  #emit(track: Track, bytes: number, final: boolean): void {
    const n = this.#count[track] + 1
    const segment = {
      track,
      speaker:
        track === 'them' && this.#speakers > 0
          ? `Speaker ${((n - 1) % this.#speakers) + 1}`
          : speakerFor(track),
      at: Math.floor(this.#done[track] / PCM_BYTES_PER_MS),
      durationMs: Math.floor(bytes / PCM_BYTES_PER_MS),
      text: `${track} segment ${n}`,
      final,
    }
    if (final) {
      this.#count[track] = n
      this.#done[track] += bytes
      this.#partialSent[track] = false
    }
    this.#events.segment(segment)
  }
}
