import { slugify } from './paths.js'
import { SPACE_LAYOUT } from './space.js'

export interface TranscriptLine {
  /** Seconds from the start of the meeting. */
  at: number
  speaker: string
  text: string
}

/**
 * `meetings/YYYY/MM/YYYY-MM-DD-<slug>.md` and its `.transcript.md` sibling. The date is the
 * calendar day in the runtime's local time zone, which is the meeting's day for the person
 * who held it when this runs in their browser.
 */
export function meetingPaths(date: Date, title: string): { note: string; transcript: string } {
  const yyyy = String(date.getFullYear()).padStart(4, '0')
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const base = `${SPACE_LAYOUT.meetings}/${yyyy}/${mm}/${yyyy}-${mm}-${dd}-${slugify(title)}`
  return { note: `${base}.md`, transcript: `${base}.transcript.md` }
}

/** `[hh:mm:ss] **Speaker:** text`, one line; newlines in the text become spaces. */
export function formatTranscriptLine(t: TranscriptLine): string {
  const total = Math.max(0, Math.floor(t.at))
  const hh = pad(Math.floor(total / 3600))
  const mm = pad(Math.floor((total % 3600) / 60))
  const ss = pad(total % 60)
  return `[${hh}:${mm}:${ss}] **${t.speaker}:** ${t.text.replace(/\s*\r?\n\s*/g, ' ')}`
}

/** How close in time (ms) a "me" line must be to a "them" line to count as its echo. */
export const ECHO_WINDOW_MS = 4000

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Drops "me" lines that are the other side heard again through the speakers: a call on a
 * laptop's speakers reaches the mic, so its words come back on "me" a moment after "them". A
 * "me" line of four words or more is an echo when a "them" line starting within
 * `ECHO_WINDOW_MS` holds at least 70% of its distinct words. Order is kept.
 */
export function dropEchoes<T extends { track: string; at: number; text: string }>(
  segments: T[],
  windowMs = ECHO_WINDOW_MS,
): T[] {
  const them = segments
    .filter((s) => s.track === 'them')
    .map((s) => ({ at: s.at, words: new Set(words(s.text)) }))
  if (them.length === 0) return segments
  return segments.filter((s) => {
    if (s.track !== 'me') return true
    const mine = new Set(words(s.text))
    if (mine.size < 4) return true
    return !them.some((t) => {
      if (Math.abs(t.at - s.at) > windowMs) return false
      let shared = 0
      for (const w of mine) if (t.words.has(w)) shared++
      return shared / mine.size >= 0.7
    })
  })
}

/**
 * The transcript a meeting note names in its frontmatter `transcript`: a path relative to the
 * note's folder. Null when the key is missing or not a non-empty string, or when the path climbs
 * out (`..`) or starts at the root (`/`).
 */
export function transcriptPathFor(
  notePath: string,
  frontmatter: { transcript?: unknown },
): string | null {
  const name = typeof frontmatter.transcript === 'string' ? frontmatter.transcript.trim() : ''
  if (name === '' || name.includes('..') || name.startsWith('/')) return null
  return `${notePath.slice(0, notePath.lastIndexOf('/') + 1)}${name}`
}

/** The labels Deepgram gives the call's side when it tells voices apart: "Speaker 1", "Speaker 2"… */
export const UNNAMED_SPEAKER = /^Speaker \d+$/

/**
 * A name a speaker label can take: one line, 1–60 characters of letters, digits, spaces and
 * `.,'’&-` (so never the `*` and `:` that delimit the label in a transcript line, nor markup),
 * and never "Me" (the note-taker's own label).
 */
export function cleanSpeakerName(name: string): string | null {
  // Letters, digits, spaces and the punctuation names use. Anything that could be markup in a
  // note (`![](…)`, `<img>`, backticks) goes: names can come from outside invitees' calendars.
  const clean = name
    .replace(/[^\p{L}\p{M}\p{N} .,'’&-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean === '' || clean.length > 60 || clean.toLowerCase() === 'me') return null
  return clean
}

/**
 * The transcript with each speaker label in `names` replaced by its new name; every other line,
 * and every byte of the lines it doesn't rename, stays as it was.
 */
export function renameSpeakers(text: string, names: Record<string, string>): string {
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      const m = TRANSCRIPT_LINE.exec(part)
      if (!m) return part
      const label = m[4] ?? ''
      if (!Object.hasOwn(names, label)) return part
      const to = names[label] ?? label
      const at = part.indexOf('] **') + 4
      return `${part.slice(0, at)}${to}${part.slice(at + (m[4] ?? '').length)}`
    })
    .join('')
}

/** One misheard word or phrase on a transcript line (counted from 0 among transcript lines). */
export interface TranscriptWordFix {
  line: number
  from: string
  to: string
}

/**
 * The transcript with each fix applied to the spoken text of its line: every whole-word `from`
 * becomes `to`. Labels, timestamps, other lines and line endings keep every byte; a fix whose
 * `from` isn't on its line changes nothing.
 */
export function fixTranscriptWords(text: string, fixes: TranscriptWordFix[]): string {
  const byLine = new Map<number, TranscriptWordFix[]>()
  for (const f of fixes) {
    // A line break or other control character in either would forge a new transcript line.
    if (f.from === '' || f.from === f.to || CONTROL.test(f.from) || CONTROL.test(f.to)) continue
    byLine.set(f.line, [...(byLine.get(f.line) ?? []), f])
  }
  if (byLine.size === 0) return text
  let n = -1
  return text
    .split(/(\r?\n)/)
    .map((part, i) => {
      if (i % 2 === 1) return part
      const m = TRANSCRIPT_LINE.exec(part)
      if (!m) return part
      n++
      const lineFixes = byLine.get(n)
      if (!lineFixes) return part
      const spoken = m[5] ?? ''
      const head = part.slice(0, part.length - spoken.length)
      let out = spoken
      // Longest first, so "Acme bio lab" is fixed before "Acme".
      for (const f of [...lineFixes].sort((a, b) => b.from.length - a.from.length)) {
        out = out.replace(wholeWord(f.from), () => f.to)
      }
      return head + out
    })
    .join('')
}

const CONTROL = /[\p{Cc}\u2028\u2029]/u

function wholeWord(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu')
}

const TRANSCRIPT_LINE = /^\[(\d{2,}):([0-5]\d):([0-5]\d)\] \*\*(.+?):\*\* ?(.*)$/

/** Every well-formed transcript line, in order. Headings, frontmatter, and other lines are skipped. */
export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = TRANSCRIPT_LINE.exec(line)
    if (!m) continue
    const at = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    out.push({ at, speaker: m[4] ?? '', text: m[5] ?? '' })
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
