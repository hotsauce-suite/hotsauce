import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { LLM } from '../meetings/llm/types.js'
import { cleanTranscript } from './cleaner.js'
import { type DictationStyle, styleForApp } from './prompt.js'
import { RateLimiter } from './rate-limit.js'
import type { DictationStore } from './store.js'
import type { DictationTranscriber } from './transcriber.js'
import { readWav } from './wav.js'

export const MAX_DICTATION_BYTES = 15 * 1024 * 1024
export const MAX_DICTATION_MS = 10 * 60 * 1000
export const MAX_KEYTERMS = 100
export const DICTATION_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/webm',
] as const
const RATE_LIMIT_PER_MINUTE = 30
/** Utterances this short skip the cleanup model (see `skipsCleanup`). */
export const SHORT_UTTERANCE_WORDS = 3
const SHORT_UTTERANCE_CHARS = 25
// Words the cleanup acts on even in a short utterance: formatting commands and self-corrections.
const SPOKEN_COMMANDS =
  /\b(new (line|paragraph)|bullet|period|full stop|comma|colon|question mark|exclamation|scratch that|no wait|actually|i mean)\b/i

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * A few plain words have nothing for the model to clean. Character count too: Chinese, Japanese
 * and Thai have no spaces, so a whole sentence would count as one word.
 */
export function skipsCleanup(raw: string): boolean {
  // Chinese, Japanese and Thai are written without spaces: count characters, a few per word.
  const words = NO_SPACE_SCRIPTS.test(raw) ? Math.ceil(raw.length / 2) : wordCount(raw)
  return (
    words <= SHORT_UTTERANCE_WORDS &&
    raw.length <= SHORT_UTTERANCE_CHARS &&
    !SPOKEN_COMMANDS.test(raw)
  )
}

const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

/**
 * What the model would still have done to a short utterance: dictionary spellings, and no
 * trailing period on a single short sentence in a chat app.
 */
export function tidyShort(
  raw: string,
  style: DictationStyle,
  dictionary: readonly string[],
): string {
  let text = raw
  for (const word of dictionary) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), word)
  }
  if (style === 'chat' && /^[^.!?]*\.$/.test(text)) text = text.slice(0, -1)
  return text
}

export interface DictateRequest {
  audio: Uint8Array
  mimeType: string
  mode: 'clean' | 'literal'
  appName?: string | undefined
  appBundle?: string | undefined
  language?: string | undefined
}

export interface DictateResult {
  text: string
  raw: string
  cleaned: boolean
  durationMs: number
  ms: { asr: number; llm: number }
}

/** Hearth Dictate on the server (ARCHITECTURE §9): transcribe, then clean, with the member's words. */
export class Dictation {
  readonly store: DictationStore
  readonly #transcriber: DictationTranscriber
  readonly #llm: LLM
  readonly #model: string
  readonly #limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE, 60_000)
  readonly #log: (message: string) => void

  constructor(opts: {
    store: DictationStore
    transcriber: DictationTranscriber
    llm: LLM
    model: string
    log?: (message: string) => void
  }) {
    this.#log = opts.log ?? ((message) => console.log(message))
    this.store = opts.store
    this.#transcriber = opts.transcriber
    this.#llm = opts.llm
    this.#model = opts.model
  }

  /** The member's words then the team's, deduplicated. */
  dictionary(userId: string): string[] {
    const seen = new Set<string>()
    return [...this.store.words(userId), ...this.store.words('team')].filter((w) => {
      const key = w.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /** Counts one dictation against the member's 30 a minute; rate_limited past it. */
  takeSlot(principal: Principal): void {
    if (!this.#limiter.take(principal.email)) {
      throw new HearthError('rate_limited', 'Too many dictations in the last minute; wait a moment')
    }
  }

  /** The words to bias recognition toward: the member's, then the team's, at most 100. */
  keyterms(principal: Principal): string[] {
    return this.dictionary(principal.userId).slice(0, MAX_KEYTERMS)
  }

  async dictate(principal: Principal, req: DictateRequest): Promise<DictateResult> {
    this.takeSlot(principal)
    if (req.audio.length === 0) throw new HearthError('bad_request', 'No audio was sent')
    if (req.audio.length > MAX_DICTATION_BYTES) {
      throw new HearthError('bad_request', 'A dictation can be at most 15 MB', { status: 413 })
    }
    if (req.mimeType.startsWith('audio/') && req.mimeType.includes('wav')) {
      const wav = readWav(req.audio)
      if (!wav) throw new HearthError('bad_request', 'That isn’t a WAV file Hearth can read')
      if (wav.durationMs > MAX_DICTATION_MS) {
        throw new HearthError('bad_request', 'A dictation can be at most 10 minutes', {
          status: 413,
        })
      }
    }
    const asrStart = performance.now()
    const heard = await this.#transcriber.transcribe(req.audio, {
      mimeType: req.mimeType,
      keyterms: this.keyterms(principal),
      language: req.language,
    })
    return this.finish(principal, {
      transcript: heard.text,
      durationMs: heard.durationMs,
      asrMs: Math.round(performance.now() - asrStart),
      bytes: req.audio.length,
      mode: req.mode,
      appName: req.appName,
      appBundle: req.appBundle,
      via: 'upload',
    })
  }

  /**
   * Everything after the transcript, shared by the upload and the stream: the cleanup (or its
   * short-utterance shortcut) and one line of timings in the log.
   */
  async finish(
    principal: Principal,
    heard: {
      transcript: string
      durationMs: number
      asrMs: number
      bytes: number
      mode: 'clean' | 'literal'
      appName?: string | undefined
      appBundle?: string | undefined
      via: 'upload' | 'stream'
    },
  ): Promise<DictateResult> {
    const raw = heard.transcript.trim()
    const asrMs = heard.asrMs
    const dictionary = this.dictionary(principal.userId)
    const style = styleForApp({ name: heard.appName, bundle: heard.appBundle })
    let result: DictateResult
    if (heard.mode === 'literal' || raw === '') {
      result = {
        text: raw,
        raw,
        cleaned: false,
        durationMs: heard.durationMs,
        ms: { asr: asrMs, llm: 0 },
      }
    } else if (skipsCleanup(raw)) {
      // Deepgram has punctuated a few plain words already; the model would only add latency.
      result = {
        text: tidyShort(raw, style, dictionary),
        raw,
        cleaned: false,
        durationMs: heard.durationMs,
        ms: { asr: asrMs, llm: 0 },
      }
    } else {
      const llmStart = performance.now()
      const cleaned = await cleanTranscript(this.#llm, this.#model, {
        transcript: raw,
        style,
        appName: heard.appName,
        dictionary,
      })
      result = {
        text: cleaned.text,
        raw,
        cleaned: cleaned.cleaned,
        durationMs: heard.durationMs,
        ms: { asr: asrMs, llm: Math.round(performance.now() - llmStart) },
      }
    }
    // Timings only: never the audio or the text.
    this.#log(
      `dictation ${JSON.stringify({ audioMs: result.durationMs, bytes: heard.bytes, asrMs: result.ms.asr, llmMs: result.ms.llm, words: wordCount(raw), cleaned: result.cleaned, mode: heard.mode, style, via: heard.via })}`,
    )
    return result
  }
}
