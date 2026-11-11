import { z } from 'zod'
import { HearthError } from '../errors.js'
import { readWav } from './wav.js'

export interface TranscribeOptions {
  mimeType: string
  /** Words to bias recognition toward (Deepgram `keyterm`). */
  keyterms: string[]
  language?: string | undefined
}

export interface TranscribeResult {
  text: string
  durationMs: number
}

/** Batch speech-to-text for one dictation (ARCHITECTURE §9.1). */
export interface DictationTranscriber {
  transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult>
}

/**
 * Deterministic stand-in (ASR_PROVIDER=fake). Says how long the audio was, with filler words so
 * the cleanup pass has something to remove. Records each call's options for tests.
 */
export class FakeDictationTranscriber implements DictationTranscriber {
  readonly calls: TranscribeOptions[] = []

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    this.calls.push(opts)
    // 16 kHz mono PCM16 is 32 bytes per millisecond, for audio that isn't WAV.
    const durationMs = readWav(audio)?.durationMs ?? Math.round(audio.length / 32)
    const seconds = (durationMs / 1000).toFixed(1)
    return { text: `um so this is a fake dictation, uh, of ${seconds} seconds`, durationMs }
  }
}

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
// With the cleanup's 15 s, the whole dictation stays inside the Mac app's 90 s wait.
const REQUEST_TIMEOUT_MS = 45_000

const DeepgramResponse = z.object({
  metadata: z.object({ duration: z.number() }).partial().optional(),
  results: z.object({
    channels: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string() })) })),
  }),
})

/** The pre-recorded URL: nova-3 with smart formatting, each custom word as a `keyterm`. */
export function deepgramBatchUrl(
  base: string,
  opts: { keyterms: string[]; language?: string | undefined },
): string {
  const url = new URL(base)
  url.searchParams.set('model', 'nova-3')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')
  if (opts.language) url.searchParams.set('language', opts.language)
  for (const term of opts.keyterms) url.searchParams.append('keyterm', term)
  return url.href
}

/** A Deepgram pre-recorded response as a result; asr_error when it isn't one. */
export function mapDeepgramResponse(body: unknown): TranscribeResult {
  const parsed = DeepgramResponse.safeParse(body)
  if (!parsed.success)
    throw new HearthError('asr_error', 'The transcription service answered oddly')
  const text = parsed.data.results.channels[0]?.alternatives[0]?.transcript.trim() ?? ''
  const seconds = parsed.data.metadata?.duration ?? 0
  return { text, durationMs: Math.round(seconds * 1000) }
}

export interface DeepgramDictationOptions {
  apiKey: string
  /** Tests point this at a local server. */
  url?: string
  fetch?: typeof fetch
  log?: (message: string) => void
}

/** Deepgram's pre-recorded API (ASR_PROVIDER=deepgram). Failures are asr_error; detail is logged. */
export class DeepgramDictationTranscriber implements DictationTranscriber {
  readonly #opts: DeepgramDictationOptions

  constructor(opts: DeepgramDictationOptions) {
    this.#opts = opts
  }

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    const log = this.#opts.log ?? console.error
    const url = deepgramBatchUrl(this.#opts.url ?? DEEPGRAM_LISTEN_URL, opts)
    let res: Response
    try {
      res = await (this.#opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { Authorization: `Token ${this.#opts.apiKey}`, 'Content-Type': opts.mimeType },
        body: audio as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      log(`deepgram dictation request failed: ${err instanceof Error ? err.name : 'error'}`)
      throw new HearthError('asr_error', 'Couldn’t reach the transcription service')
    }
    if (!res.ok) {
      // Deepgram's error body names the problem, never the audio's content.
      log(`deepgram dictation ${res.status}: ${(await res.text()).slice(0, 300)}`)
      throw new HearthError('asr_error', 'The transcription service refused this audio')
    }
    return mapDeepgramResponse(await res.json())
  }
}
