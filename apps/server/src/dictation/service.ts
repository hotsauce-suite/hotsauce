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
/**
 * Dictations up to this long skip the cleanup model when there is nothing in them for it to do
 * (see `skipsCleanup`): Deepgram has already punctuated them, and the model was most of the wait.
 */
export const PLAIN_UTTERANCE_WORDS = 40
// What the cleanup is for: fillers, self-corrections, spoken formatting and lists. Any of these
// sends a dictation to the model whatever its length. Common words among them ("first", "period")
// only cost a cleanup that wasn't needed, never one that was.
// Gaps inside a cue allow Deepgram's punctuation ("Tuesday, no, wait, Wednesday").
const GAP = String.raw`[\s,.;:!?-]+`
const CUE_WORDS = [
  // fillers Deepgram can keep
  'um+',
  'uh+',
  'erm',
  'er',
  'hmm+',
  `you${GAP}know`,
  // self-corrections
  `i${GAP}mean`,
  `i${GAP}meant`,
  `no${GAP}wait`,
  `wait${GAP}no`,
  `scratch${GAP}that`,
  `strike${GAP}that`,
  `delete${GAP}that`,
  `never${GAP}mind`,
  `make${GAP}that`,
  `or${GAP}rather`,
  'actually',
  'sorry',
  `let${GAP}me${GAP}rephrase`,
  'correction',
  // spoken formatting and symbols
  `new${GAP}(line|paragraph)`,
  'bullet',
  'numbered',
  'period',
  `full${GAP}stop`,
  'comma',
  'colon',
  'semicolon',
  `question${GAP}mark`,
  'exclamation',
  `(open|close)${GAP}(quote|paren|bracket)`,
  'dash',
  'hyphen',
  'slash',
  'underscore',
  'hashtag',
  `at${GAP}sign`,
  `dot${GAP}(com|org|net|io|app|co)`,
  // lists
  'first(ly)?',
  'second(ly)?',
  'third(ly)?',
  `number${GAP}(one|two)`,
  `step${GAP}(one|two)`,
]
// Whole words only: a letter or digit on either side means it's part of another word.
const CLEANUP_CUES = new RegExp(
  `(?<![\\p{L}\\p{N}])(${CUE_WORDS.join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
)
// A stutter: the same word twice in a row, with or without a comma ("the, the report").
const REPEATED_WORD = /(?<![\p{L}\p{N}])(\p{L}+)[\s,]+\1(?![\p{L}\p{N}])/iu
// The cues are English. Other languages keep the old rule: only a few words skip the model.
const OTHER_LANGUAGE_WORDS = 3
const NON_ASCII_LETTER = /[^\p{ASCII}](?<=\p{L})/u

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Whether a transcript can be pasted as Deepgram gave it: short enough that paragraphing doesn't
 * matter, and nothing the cleanup acts on. Chinese, Japanese and Thai have no spaces, so they
 * count two characters a word.
 */
export function skipsCleanup(raw: string, language?: string): boolean {
  const words = NO_SPACE_SCRIPTS.test(raw) ? Math.ceil(raw.length / 2) : wordCount(raw)
  const english = (language === undefined || /^en\b/i.test(language)) && !NON_ASCII_LETTER.test(raw)
  const limit = english ? PLAIN_UTTERANCE_WORDS : OTHER_LANGUAGE_WORDS
  return words <= limit && !CLEANUP_CUES.test(raw) && !REPEATED_WORD.test(raw)
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

/** What the cleanup needs to know about where the text is going. */
export interface CleanupContext {
  mode: 'clean' | 'literal'
  language?: string | undefined
  appName?: string | undefined
  appBundle?: string | undefined
}

/** A cleanup started before key-up on the transcript as it stood then. */
export interface Speculation {
  transcript: string
  result: Promise<{ text: string; cleaned: boolean; skipped: boolean }>
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
    const asrStart = performance.now()
    const heard = await this.hear(principal, req)
    return this.finish(principal, {
      transcript: heard.text,
      durationMs: heard.durationMs,
      asrMs: Math.round(performance.now() - asrStart),
      bytes: req.audio.length,
      mode: req.mode,
      appName: req.appName,
      appBundle: req.appBundle,
      language: req.language,
      via: 'upload',
    })
  }

  /**
   * The transcript of one recording with the member's words, no cleanup: counted against their
   * 30 a minute, at most 15 MB and (for a WAV) 10 minutes. Hearth Tasks' Ramble uses it too.
   */
  async hear(
    principal: Principal,
    req: { audio: Uint8Array; mimeType: string; language?: string | undefined },
  ): Promise<{ text: string; durationMs: number }> {
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
    return this.#transcriber.transcribe(req.audio, {
      mimeType: req.mimeType,
      keyterms: this.keyterms(principal),
      language: req.language,
    })
  }

  /**
   * Everything after the transcript, shared by the upload and the stream: the cleanup (or its
   * short-utterance shortcut) and one line of timings in the log.
   */
  /**
   * Starts the cleanup of a transcript ahead of key-up (the stream calls it in pauses), so that if
   * nothing more is said, the result is ready when the key comes up. Null when there is nothing
   * to clean.
   */
  speculate(principal: Principal, transcript: string, context: CleanupContext): Speculation | null {
    const raw = transcript.trim()
    if (context.mode === 'literal' || raw === '' || skipsCleanup(raw, context.language)) return null
    return { transcript: raw, result: this.#clean(principal, raw, context) }
  }

  /**
   * Everything after the transcript, shared by the upload and the stream: the cleanup (or its
   * shortcut for plain dictations) and one line of timings in the log. A speculation made on
   * this exact transcript is used instead of a fresh cleanup.
   */
  async finish(
    principal: Principal,
    heard: CleanupContext & {
      transcript: string
      durationMs: number
      asrMs: number
      bytes: number
      via: 'upload' | 'stream'
    },
    speculation?: Speculation | null,
  ): Promise<DictateResult> {
    const raw = heard.transcript.trim()
    const style = styleForApp({ name: heard.appName, bundle: heard.appBundle })
    const llmStart = performance.now()
    let cleanup: { text: string; cleaned: boolean; skipped: boolean }
    let speculated = false
    if (heard.mode === 'literal' || raw === '') {
      cleanup = { text: raw, cleaned: false, skipped: true }
    } else if (speculation && speculation.transcript === raw) {
      speculated = true
      cleanup = await speculation.result
    } else {
      cleanup = await this.#clean(principal, raw, heard)
    }
    // What the member waited for: with a speculation, only what was left of it after key-up.
    const llmMs = cleanup.skipped ? 0 : Math.round(performance.now() - llmStart)
    const result: DictateResult = {
      text: cleanup.text,
      raw,
      cleaned: cleanup.cleaned,
      durationMs: heard.durationMs,
      ms: { asr: heard.asrMs, llm: llmMs },
    }
    // Timings only: never the audio or the text.
    this.#log(
      `dictation ${JSON.stringify({ audioMs: result.durationMs, bytes: heard.bytes, asrMs: result.ms.asr, llmMs, words: wordCount(raw), cleaned: result.cleaned, skipped: cleanup.skipped, speculated, mode: heard.mode, style, via: heard.via })}`,
    )
    return result
  }

  /** The cleanup model, or the shortcut for a plain dictation. */
  async #clean(
    principal: Principal,
    raw: string,
    context: CleanupContext,
  ): Promise<{ text: string; cleaned: boolean; skipped: boolean }> {
    const dictionary = this.dictionary(principal.userId)
    const style = styleForApp({ name: context.appName, bundle: context.appBundle })
    if (skipsCleanup(raw, context.language)) {
      // Deepgram has punctuated it already and there's nothing to fix: the model would only add
      // latency (it was most of the wait).
      return { text: tidyShort(raw, style, dictionary), cleaned: false, skipped: true }
    }
    const cleaned = await cleanTranscript(this.#llm, this.#model, {
      transcript: raw,
      style,
      appName: context.appName,
      dictionary,
    })
    return { ...cleaned, skipped: false }
  }
}
