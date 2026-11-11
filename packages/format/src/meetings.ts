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
