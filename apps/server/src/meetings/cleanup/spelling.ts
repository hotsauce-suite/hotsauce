import { parseTranscript, type TranscriptWordFix } from '@hearth/format'
import type { LLM } from '../llm/types.js'

/** Past this many characters of transcript, the pass is skipped (about three hours of talk). */
export const MAX_SPELLING_CHARS = 300_000
const MAX_FIXES = 200
const MAX_PHRASE = 60

export const SPELLING_SYSTEM = `You fix misheard names and terms in a meeting transcript made by speech recognition.

You get a word list (people's names, company names, product terms, spelled the way the team spells them) and the transcript, one numbered line each.

Find places where speech recognition wrote one of the word list's entries wrongly: split into pieces ("acme bio lab"), spelled by sound ("pria" for "Priya"), or with the wrong capitals. Only fix a place when the line is clearly saying that entry. Never fix anything else: not grammar, not filler words, not other words, even if they look wrong.

Answer with JSON only, no prose: an array of {"line": <number>, "from": "<exact text as it appears on that line>", "to": "<the word list entry>"}. Answer [] when there is nothing to fix.`

/** The user message: the word list, then each transcript line as `<n>: <speaker>: <text>`. */
export function spellingPrompt(transcript: string, vocabulary: string[]): string {
  const lines = parseTranscript(transcript)
    .map((l, i) => `${i}: ${l.speaker}: ${l.text}`)
    .join('\n')
  return `<word_list>\n${vocabulary.join('\n')}\n</word_list>\n\n<cleanup_transcript>\n${lines}\n</cleanup_transcript>`
}

/**
 * The fixes Claude proposes, kept only when they are safe: on a real line, `from` is on that
 * line, `to` is one of the word list's entries (spelled as the list spells it), and the two
 * differ. Anything unreadable is no fixes at all.
 */
export function parseSpellingFixes(
  answer: string,
  transcript: string,
  vocabulary: string[],
): TranscriptWordFix[] {
  const json = answer.slice(answer.indexOf('['), answer.lastIndexOf(']') + 1)
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const lines = parseTranscript(transcript)
  const canonical = new Map(vocabulary.map((v) => [v.toLowerCase(), v]))
  const out: TranscriptWordFix[] = []
  for (const item of raw.slice(0, MAX_FIXES)) {
    if (typeof item !== 'object' || item === null) continue
    const { line, from, to } = item as Record<string, unknown>
    if (typeof line !== 'number' || typeof from !== 'string' || typeof to !== 'string') continue
    const text = lines[line]?.text
    const entry = canonical.get(to.trim().toLowerCase())
    if (text === undefined || entry === undefined) continue
    if (from.length < 2 || from.length > MAX_PHRASE || from === entry || !text.includes(from))
      continue
    // Never one known name for another ("Dana" → "Priya"), only a mishearing of this one.
    // Parts of this entry ("Shah" in "Priya Shah") don't count as another name.
    const other = vocabulary.some((v) => {
      const k = v.toLowerCase()
      return k.length >= 3 && !entry.toLowerCase().includes(k) && from.toLowerCase().includes(k)
    })
    if (other || !soundsLike(from, entry)) continue
    out.push({ line, from, to: entry })
  }
  return out
}

/** One Claude call: the fixes for this transcript, or none (no word list, too long, or no answer). */
export async function spellingFixes(
  llm: LLM,
  model: string,
  transcript: string,
  vocabulary: string[],
): Promise<TranscriptWordFix[]> {
  if (vocabulary.length === 0 || transcript.length > MAX_SPELLING_CHARS) return []
  if (parseTranscript(transcript).length === 0) return []
  const { text } = await llm.complete({
    model,
    system: SPELLING_SYSTEM,
    messages: [{ role: 'user', content: spellingPrompt(transcript, vocabulary) }],
    maxTokens: 8000,
  })
  return parseSpellingFixes(text, transcript, vocabulary)
}

/**
 * Whether `from` could be `to` misheard: the same letters and digits, ignoring case and spaces,
 * within an edit distance of 40% of the longer one ("acme bio lab" and "AcmeBioLab", "pria"
 * and "Priya"; not "a" and "Al", nor "contract" and "Priya").
 */
export function soundsLike(from: string, to: string): boolean {
  const a = squash(from)
  const b = squash(to)
  if (a.length === 0 || b.length === 0) return false
  const longest = Math.max(a.length, b.length)
  return editDistance(a, b) <= Math.floor(longest * 0.4)
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = row
  }
  return prev[b.length] ?? 0
}
