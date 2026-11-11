import { HearthError } from '../errors.js'
import type { LLM } from '../meetings/llm/types.js'
import { buildCleanupPrompt, type CleanupInput, extractCleaned } from './prompt.js'

export interface CleanupResult {
  text: string
  cleaned: boolean
}

// A cleaned text this much longer than the transcript wasn't cleaned: the model answered or
// added something. Lists and punctuation add a little, never this much.
const MAX_GROWTH_FACTOR = 1.6
const MAX_GROWTH_SLACK = 80
// The Mac waits about a minute in all; a slow model gets this long, then the raw text goes back.
export const CLEANUP_TIMEOUT_MS = 15_000

/**
 * Room for the cleaned text, which is about as long as the transcript. Latin-script text is three
 * or four characters a token; other scripts can be one, so they get a token per character.
 */
export function cleanupTokenBudget(raw: string): number {
  const latin = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u.test(raw)
  return Math.min(4_000, 64 + (latin ? Math.ceil(raw.length / 2) : raw.length))
}

/**
 * Runs the cleanup pass. Never fails the dictation: if the model errors, or returns something
 * that can't be a cleaning of the transcript, the raw transcript comes back with cleaned: false.
 */
export async function cleanTranscript(
  llm: LLM,
  model: string,
  input: CleanupInput,
  log: (message: string) => void = console.warn,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<CleanupResult> {
  const raw = input.transcript.trim()
  if (raw === '') return { text: '', cleaned: false }
  const { system, user } = buildCleanupPrompt(input)
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HearthError('llm_error', 'timed out')), timeoutMs)
    })
    const { text } = await Promise.race([
      llm.complete({
        model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: cleanupTokenBudget(raw),
      }),
      timeout,
    ]).finally(() => clearTimeout(timer))
    const cleaned = extractCleaned(text)
    if (cleaned === null) {
      log('dictation cleanup answered without <cleaned>; using the raw transcript')
      return { text: raw, cleaned: false }
    }
    if (cleaned.length > raw.length * MAX_GROWTH_FACTOR + MAX_GROWTH_SLACK) {
      log(
        `dictation cleanup grew ${raw.length} → ${cleaned.length} chars; using the raw transcript`,
      )
      return { text: raw, cleaned: false }
    }
    // Only filler: the model rightly returns nothing.
    return { text: cleaned, cleaned: true }
  } catch (err) {
    log(
      `dictation cleanup failed: ${err instanceof HearthError ? `${err.code} ${err.message}` : err instanceof Error ? err.name : 'error'}`,
    )
    return { text: raw, cleaned: false }
  }
}
