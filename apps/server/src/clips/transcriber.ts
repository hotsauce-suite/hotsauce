import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { TranscriptSegment } from './store.js'

export interface ClipTranscribeOptions {
  mimeType: string
  /** Words to bias recognition toward (Deepgram `keyterm`): the owner's and the team's. */
  keyterms: string[]
  /** The clip's length, which the fake uses to decide how many lines to say. */
  durationMs: number
}

/** Pre-recorded speech-to-text for one clip's audio (ARCHITECTURE §10.1). */
export interface ClipTranscriber {
  transcribe(audio: Uint8Array, opts: ClipTranscribeOptions): Promise<TranscriptSegment[]>
}

/** Seconds of clip per fake line. */
export const FAKE_SEGMENT_SECONDS = 2

/**
 * Deterministic stand-in (ASR_PROVIDER=fake): "clip segment n" for every two seconds of the clip,
 * starting at n × 2 − 2 seconds, said by speakers 0 and 1 in turn. Records each call's options.
 */
export class FakeClipTranscriber implements ClipTranscriber {
  readonly calls: ClipTranscribeOptions[] = []

  async transcribe(_audio: Uint8Array, opts: ClipTranscribeOptions): Promise<TranscriptSegment[]> {
    this.calls.push(opts)
    const seconds = opts.durationMs / 1000
    const segments: TranscriptSegment[] = []
    for (let start = 0, n = 1; start < seconds; start += FAKE_SEGMENT_SECONDS, n++) {
      const end = Math.min(seconds, start + FAKE_SEGMENT_SECONDS)
      segments.push({
        start,
        end: Math.round(end * 100) / 100,
        text: `clip segment ${n}`,
        speaker: (n - 1) % 2,
      })
    }
    return segments
  }
}

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
// An hour of audio takes Deepgram well under a minute; this is the "something is wrong" line.
const REQUEST_TIMEOUT_MS = 10 * 60_000

const Sentence = z.object({ text: z.string(), start: z.number(), end: z.number() })
const Speaker = z.number().int().nonnegative().optional()
const DeepgramResponse = z.object({
  results: z.object({
    channels: z.array(
      z.object({
        alternatives: z.array(
          z.object({
            transcript: z.string(),
            paragraphs: z
              .object({
                paragraphs: z.array(z.object({ sentences: z.array(Sentence), speaker: Speaker })),
              })
              .optional(),
          }),
        ),
      }),
    ),
    utterances: z
      .array(
        z.object({ transcript: z.string(), start: z.number(), end: z.number(), speaker: Speaker }),
      )
      .optional(),
  }),
})

/** The pre-recorded URL: nova-3, smart formatting, paragraphs, utterances, speakers, keyterms. */
export function deepgramClipUrl(base: string, keyterms: string[]): string {
  const url = new URL(base)
  url.searchParams.set('model', 'nova-3')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  url.searchParams.set('paragraphs', 'true')
  url.searchParams.set('utterances', 'true')
  url.searchParams.set('diarize', 'true')
  for (const term of keyterms) url.searchParams.append('keyterm', term)
  return url.href
}

const round = (s: number) => Math.round(s * 100) / 100

/**
 * One line per sentence, from Deepgram's paragraphs, with the paragraph's speaker; its utterances,
 * or the whole transcript at 0:00, when there are none. asr_error when the body isn't a Deepgram
 * response.
 */
export function mapDeepgramClip(body: unknown): TranscriptSegment[] {
  const parsed = DeepgramResponse.safeParse(body)
  if (!parsed.success) {
    throw new HearthError('asr_error', 'The transcription service answered oddly')
  }
  const alt = parsed.data.results.channels[0]?.alternatives[0]
  const sentences = (alt?.paragraphs?.paragraphs ?? []).flatMap((p) =>
    p.sentences.map((s) => ({ ...s, speaker: p.speaker })),
  )
  const lines =
    sentences.length > 0
      ? sentences
      : (parsed.data.results.utterances ?? []).map((u) => ({
          start: u.start,
          end: u.end,
          text: u.transcript,
          speaker: u.speaker,
        }))
  const segments: TranscriptSegment[] = lines
    .map((l) => ({
      start: round(l.start),
      end: round(l.end),
      text: l.text.trim(),
      ...(l.speaker !== undefined ? { speaker: l.speaker } : {}),
    }))
    .filter((l) => l.text !== '')
  if (segments.length > 0) return segments
  const text = alt?.transcript.trim() ?? ''
  return text ? [{ start: 0, end: 0, text }] : []
}

export interface DeepgramClipOptions {
  apiKey: string
  /** Tests point this at a local server. */
  url?: string
  fetch?: typeof fetch
  log?: (message: string) => void
}

/** Deepgram's pre-recorded API (ASR_PROVIDER=deepgram). Failures are asr_error; detail is logged. */
export class DeepgramClipTranscriber implements ClipTranscriber {
  readonly #opts: DeepgramClipOptions

  constructor(opts: DeepgramClipOptions) {
    this.#opts = opts
  }

  async transcribe(audio: Uint8Array, opts: ClipTranscribeOptions): Promise<TranscriptSegment[]> {
    const log = this.#opts.log ?? console.error
    const url = deepgramClipUrl(this.#opts.url ?? DEEPGRAM_LISTEN_URL, opts.keyterms)
    let res: Response
    try {
      res = await (this.#opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { Authorization: `Token ${this.#opts.apiKey}`, 'Content-Type': opts.mimeType },
        body: audio as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      log(`deepgram clip request failed: ${err instanceof Error ? err.name : 'error'}`)
      throw new HearthError('asr_error', 'Couldn’t reach the transcription service')
    }
    if (!res.ok) {
      // Deepgram's error body names the problem, never the audio's content.
      log(`deepgram clip ${res.status}: ${(await res.text()).slice(0, 300)}`)
      throw new HearthError('asr_error', 'The transcription service refused this audio')
    }
    return mapDeepgramClip(await res.json())
  }
}
