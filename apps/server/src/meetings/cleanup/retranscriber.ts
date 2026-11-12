import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { HearthError } from '../../errors.js'
import { pcmSeconds, WAV_HEADER_BYTES, wavStream } from '../audio/wav.js'
import { diarizedSpeaker } from '../transcriber/deepgram.js'
import { speakerFor, type Track, type TranscriptSegment } from '../transcriber/types.js'

export interface RetranscribeInput {
  track: Track
  /** The session's PCM file for the track (16 kHz mono PCM16 LE) and how much of it to send. */
  file: string
  bytes: number
  /** Deepgram keyterms: the meeting's attendees and word lists. */
  vocabulary: string[]
  signal?: AbortSignal
}

/**
 * Pre-recorded speech-to-text for a whole meeting track after the call (ARCHITECTURE §7.11).
 * Segments come back final, with `at` in the track's audio milliseconds like the live ones.
 */
export interface MeetingRetranscriber {
  transcribe(input: RetranscribeInput): Promise<TranscriptSegment[]>
}

/**
 * Deterministic stand-in for tests: one line per `secondsPerLine` of the track,
 * "my clean words n" (mic) or "their tidy sentence n" (call), the call's side alternating between `speakers` labels when set.
 */
export class FakeRetranscriber implements MeetingRetranscriber {
  readonly calls: RetranscribeInput[] = []
  readonly #secondsPerLine: number
  readonly #speakers: number
  readonly #fail: boolean

  constructor(opts: { secondsPerLine?: number; speakers?: number; fail?: boolean } = {}) {
    this.#secondsPerLine = opts.secondsPerLine ?? 1
    this.#speakers = opts.speakers ?? 0
    this.#fail = opts.fail ?? false
  }

  async transcribe(input: RetranscribeInput): Promise<TranscriptSegment[]> {
    this.calls.push(input)
    // Like the real one, it reads the PCM: a file deleted under it fails the same way.
    if ((await stat(input.file)).size < input.bytes) throw new Error('PCM shorter than said')
    if (this.#fail)
      throw new HearthError('asr_error', 'The transcription service refused this audio')
    const seconds = Math.max(1, pcmSeconds(input.bytes))
    const out: TranscriptSegment[] = []
    for (let s = 0, n = 1; s < seconds; s += this.#secondsPerLine, n++) {
      const speaker =
        input.track === 'them' && this.#speakers > 0
          ? diarizedSpeaker((n - 1) % this.#speakers)
          : speakerFor(input.track)
      out.push({
        track: input.track,
        speaker,
        at: s * 1000,
        durationMs: this.#secondsPerLine * 1000,
        // Unlike the other track's words, so the echo filter keeps both.
        text: input.track === 'me' ? `my clean words ${n}` : `their tidy sentence ${n}`,
        final: true,
      })
    }
    return out
  }
}

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
// Deepgram does an hour in well under a minute; this is the "something is wrong" line. Enhance
// stops waiting long before it (TranscriptCleanup's wait).
const REQUEST_TIMEOUT_MS = 10 * 60_000

const Utterance = z.object({
  transcript: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.number().int().nonnegative().optional(),
})
const DeepgramResponse = z.object({
  results: z.object({ utterances: z.array(Utterance).optional() }),
})

/** The pre-recorded URL for one track: nova-3, smart formatting, utterances, keyterms. */
export function retranscribeUrl(
  base: string,
  opts: { model: string; vocabulary: string[]; diarize: boolean },
): string {
  const url = new URL(base)
  const params = url.searchParams
  params.set('model', opts.model)
  params.set('smart_format', 'true')
  params.set('punctuate', 'true')
  params.set('utterances', 'true')
  if (opts.diarize) params.set('diarize', 'true')
  for (const term of opts.vocabulary) params.append('keyterm', term)
  return url.href
}

/**
 * Deepgram's utterances as final segments. Diarized utterances are labelled "Speaker n" like the
 * live call side; otherwise the track's speaker. asr_error when the body isn't a Deepgram answer.
 */
export function segmentsFromUtterances(
  body: unknown,
  track: Track,
  diarize: boolean,
): TranscriptSegment[] {
  const parsed = DeepgramResponse.safeParse(body)
  if (!parsed.success) {
    throw new HearthError('asr_error', 'The transcription service answered oddly')
  }
  return (parsed.data.results.utterances ?? [])
    .map((u) => ({
      track,
      speaker: diarize && u.speaker !== undefined ? diarizedSpeaker(u.speaker) : speakerFor(track),
      at: Math.round(u.start * 1000),
      durationMs: Math.max(0, Math.round((u.end - u.start) * 1000)),
      text: u.transcript.trim(),
      final: true,
    }))
    .filter((s) => s.text !== '')
}

export interface DeepgramRetranscriberOptions {
  apiKey: string
  model?: string
  /** Tests point this at a local server. */
  url?: string
  fetch?: typeof fetch
  log?: (message: string) => void
}

/** Deepgram's pre-recorded API, streaming the track's WAV from disk. Failures are asr_error. */
export class DeepgramRetranscriber implements MeetingRetranscriber {
  readonly #opts: DeepgramRetranscriberOptions

  constructor(opts: DeepgramRetranscriberOptions) {
    this.#opts = opts
  }

  async transcribe(input: RetranscribeInput): Promise<TranscriptSegment[]> {
    const log = this.#opts.log ?? console.error
    // Only the call's side can be several people; the mic is the member (as live).
    const diarize = input.track === 'them'
    const url = retranscribeUrl(this.#opts.url ?? DEEPGRAM_LISTEN_URL, {
      model: this.#opts.model ?? 'nova-3',
      vocabulary: input.vocabulary,
      diarize,
    })
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let res: Response
    try {
      res = await (this.#opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.#opts.apiKey}`,
          'Content-Type': 'audio/wav',
          // Known up front, so the body goes as one sized upload, not chunked.
          'Content-Length': String(input.bytes + WAV_HEADER_BYTES),
        },
        body: Readable.toWeb(wavStream(input.file, input.bytes)) as ReadableStream<Uint8Array>,
        // Streamed from disk (Node's fetch needs this to send a stream), never held in memory.
        duplex: 'half',
        signal,
      } as RequestInit & { duplex: 'half' })
    } catch (err) {
      log(`deepgram retranscribe request failed: ${err instanceof Error ? err.name : 'error'}`)
      throw new HearthError('asr_error', 'Couldn’t reach the transcription service')
    }
    if (!res.ok) {
      // Deepgram's error body names the problem, never the audio's content.
      log(`deepgram retranscribe ${res.status}: ${(await res.text()).slice(0, 300)}`)
      throw new HearthError('asr_error', 'The transcription service refused this audio')
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      // A JSON error quotes the body, which is the transcript: log nothing of it.
      log('deepgram retranscribe: the answer was not JSON')
      throw new HearthError('asr_error', 'The transcription service answered oddly')
    }
    return segmentsFromUtterances(body, input.track, diarize)
  }
}
