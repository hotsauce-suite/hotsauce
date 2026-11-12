import {
  cleanSpeakerName,
  formatTranscriptLine,
  meetingPaths,
  newId,
  patchFrontmatter,
  type TranscriptLine,
} from '@hearth/format'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import type { Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import { blobOidOf } from './enhance/note.js'
import { rawNotesPath } from './files.js'
import { assertTimeZone, calendarDayIn, isoInZone, zonedParts } from './zoned-time.js'

/** Meetings per request; the page sends a big export in batches. */
export const MAX_IMPORT_MEETINGS = 100
const MAX_TEXT = 200_000
const MAX_TRANSCRIPT = 2_000_000

/** One meeting from Granola's CSV export, as the page reads it (ARCHITECTURE §7.12). */
export const GranolaMeeting = z.object({
  /** Granola's document id, or a hash the page makes of title and date when there is none. */
  ref: z.string().trim().min(1).max(200),
  title: z.string().max(500),
  /** When it happened, as the export says (ISO 8601 is what Granola writes). */
  date: z.string().max(100),
  /** What the member typed. */
  notes: z.string().max(MAX_TEXT),
  /** Granola's AI summary, Markdown. */
  summary: z.string().max(MAX_TEXT),
  transcript: z.string().max(MAX_TRANSCRIPT),
  attendees: z.array(z.string().max(300)).max(200).optional(),
})
export type GranolaMeeting = z.infer<typeof GranolaMeeting>

export interface ImportGranolaDeps {
  git: Pick<GitStore, 'commit' | 'listAll'>
  index: Pick<Index, 'listFiles'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  /** Index and announce the commit, so the next batch sees what this one added. */
  afterCommit: (space: string) => Promise<void>
}

// One import at a time per member, so overlapping batches can't add the same meeting twice.
const importing = new Map<string, Promise<unknown>>()

/**
 * `POST /api/meetings/import/granola`: Granola meetings become ordinary meeting notes in the
 * member's personal space: note (their notes, then Granola's summary marked as AI), raw notes,
 * and transcript, in one commit as the member. Re-runnable: a meeting already imported (same
 * `import_ref`) is skipped, as is one with no date or no content.
 */
export async function importGranola(
  deps: ImportGranolaDeps,
  principal: Principal,
  meetings: GranolaMeeting[],
  tz: string,
): Promise<{ imported: number; skipped: number; space: string }> {
  assertTimeZone(tz)
  const key = principal.email.toLowerCase()
  const before = importing.get(key) ?? Promise.resolve()
  const run = before.catch(() => {}).then(() => importBatch(deps, principal, meetings, tz))
  importing.set(key, run)
  try {
    return await run
  } finally {
    if (importing.get(key) === run) importing.delete(key)
  }
}

async function importBatch(
  deps: ImportGranolaDeps,
  principal: Principal,
  meetings: GranolaMeeting[],
  tz: string,
): Promise<{ imported: number; skipped: number; space: string }> {
  const space = (await deps.spaces.visibleSpaces(principal)).find((s) => s.kind === 'personal')
  if (!space) throw new HearthError('forbidden', 'Your personal space isn’t ready yet')
  // Bring the index up to date first (an earlier batch whose indexing failed, outside pushes),
  // since it is what tells us which meetings are already here.
  await deps.afterCommit(space.name)
  const done = new Set<string>()
  for (const f of deps.index.listFiles({ space: space.name, kind: 'meeting' })) {
    const fm = f.frontmatter
    if (fm?.imported_from === 'granola' && typeof fm.import_ref === 'string')
      done.add(fm.import_ref)
  }
  const taken = new Set((await deps.git.listAll(space.name)).map((e) => e.path))
  const changes: Array<{ path: string; content: string }> = []
  let skipped = 0
  for (const m of meetings) {
    const files = done.has(m.ref) ? null : granolaFiles(m, taken, tz)
    if (!files) {
      skipped++
      continue
    }
    done.add(m.ref)
    for (const f of files) taken.add(f.path)
    changes.push(...files)
  }
  const imported = meetings.length - skipped
  if (imported > 0) {
    await deps.git.commit(space.name, {
      changes,
      author: { name: principal.name, email: principal.email },
      message: formatCommitMessage({
        app: 'meetings',
        verb: 'import',
        title: `${imported} from Granola`,
      }),
    })
    await deps.afterCommit(space.name)
  }
  return { imported, skipped, space: space.name }
}

/**
 * A Granola meeting's files, at the first free `-n` paths: the note, its raw notes, and its
 * transcript when it has one. Null when it can't be placed (no usable date, nothing in it).
 */
export function granolaFiles(
  m: GranolaMeeting,
  taken: ReadonlySet<string>,
  tz: string,
): Array<{ path: string; content: string }> | null {
  const instant = instantOf(m.date, tz)
  if (!instant) return null
  const day = calendarDayIn(instant, tz)
  const notes = m.notes.replace(/\r\n?/g, '\n').trim()
  const title = oneLine(m.title) || 'Granola meeting'
  const summary = withoutLeadingHeading(m.summary.replace(/\r\n?/g, '\n').trim(), title)
  const lines = granolaTranscript(m.transcript)
  if (!notes && !summary && lines.length === 0) return null
  const base = meetingPaths(day, title)
  let note = base.note
  let transcript = base.transcript
  for (let n = 2; taken.has(note) || taken.has(transcript); n++) {
    if (n > 999) return null
    note = base.note.replace(/\.md$/, `-${n}.md`)
    transcript = base.transcript.replace(/\.transcript\.md$/, `-${n}.transcript.md`)
  }

  const id = newId()
  const parts = [`# ${title}`]
  if (notes) parts.push(`## My notes\n\n${notes}`)
  // The summary's heading: after what's above it and one blank line (1-based body lines).
  const aiFrom = parts.join('\n\n').split('\n').length + 2
  if (summary) parts.push(`## Summary\n\n${summary}`)
  const body = `${parts.join('\n\n')}\n`
  const lastLine = body.split('\n').length - 1
  const frontmatter: Record<string, unknown> = {
    id,
    type: 'meeting',
    title,
    date: isoInZone(instant, tz),
    attendees: m.attendees?.map(oneLine).filter(Boolean),
    // Always a transcript file, even an empty one, so Enhance works on every imported note.
    transcript: transcript.slice(transcript.lastIndexOf('/') + 1),
    // Granola's summary is AI-written: shown as AI text, and Enhance may replace it unasked.
    ai_ranges: summary ? [[aiFrom, lastLine]] : [],
    // The body as Hearth wrote it, so Enhance knows the note hasn't been edited since.
    models: summary
      ? { enhance: 'granola', enhanced_blob: blobOidOf(body) }
      : { enhanced_blob: blobOidOf(body) },
    imported_from: 'granola',
    import_ref: m.ref,
  }
  const text = lines.map(formatTranscriptLine).join('\n')
  return [
    { path: note, content: patchFrontmatter(body, frontmatter) },
    { path: rawNotesPath(id), content: notes ? `${notes}\n` : '' },
    { path: transcript, content: `# ${title}: transcript\n\n${text}${text ? '\n' : ''}` },
  ]
}

/** `Speaker: text` lines, optionally after a `[h:mm:ss]` or `(mm:ss)` time. */
const LABELLED = /^\s*(?:[[(]((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]\s*)?([^:\n]{1,40}?):\s+(\S.*)$/
/** What a speaker label looks like: Me, You, Them, or a name of up to four capitalised words. */
const SPEAKER =
  /^(?:[Mm][Ee]|[Yy][Oo][Uu]|[Tt][Hh][Ee][Mm]|\p{Lu}[\p{L}'’.-]*(?: [\p{Lu}\d][\p{L}\d'’.-]*){0,3})$/u

/**
 * Granola's transcript cell as transcript lines. When most lines start with a speaker label
 * ("Me: ", "Them: ", "Priya: "), those labels are kept (a line without one continues the one
 * before); otherwise every line is "Speaker". Times are kept when given, else 0:00.
 */
export function granolaTranscript(text: string): TranscriptLine[] {
  const raw = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (raw.length === 0) return []
  const matches = raw.map((l) => {
    const m = LABELLED.exec(l)
    return m && SPEAKER.test((m[2] ?? '').replace(/[*_]/g, '').trim()) ? m : null
  })
  const labelled = matches.filter(Boolean).length >= raw.length / 2
  const out: TranscriptLine[] = []
  raw.forEach((line, i) => {
    const m = labelled ? matches[i] : null
    if (!m) {
      const last = out[out.length - 1]
      if (labelled && last) last.text = `${last.text} ${line}`
      else out.push({ at: 0, speaker: 'Speaker', text: line })
      return
    }
    out.push({
      at: m[1] ? seconds(m[1]) : (out.at(-1)?.at ?? 0),
      speaker: label(m[2] ?? ''),
      text: m[3] ?? '',
    })
  })
  return out
}

function label(raw: string): string {
  const t = raw.trim()
  if (/^(me|you)$/i.test(t)) return 'Me'
  if (/^them$/i.test(t)) return 'Them'
  return cleanSpeakerName(t) ?? 'Speaker'
}

function seconds(time: string): number {
  return time.split(':').reduce((n, p) => n * 60 + Number(p), 0)
}

/**
 * When the meeting started. A time with an offset (or Z) is that instant; a time or a bare date
 * without one is wall-clock time in the member's zone, as Granola shows it. Null when unreadable.
 */
export function instantOf(date: string, tz: string): Date | null {
  const t = date.trim()
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
      t,
    )
  let wall: [number, number, number, number, number, number]
  if (iso) {
    const [y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0] = iso
      .slice(1, 7)
      .map((v) => Number(v ?? 0))
    if (!validWall(y, mo, d, h, mi, sec)) return null
    if (iso[7]) {
      const instant = new Date(t.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
      return Number.isNaN(instant.getTime()) ? null : instant
    }
    wall = [y, mo, d, h, mi, sec]
  } else {
    // Any other format: an explicit zone is honoured, otherwise its fields are wall time.
    const parsed = Date.parse(t)
    if (Number.isNaN(parsed)) return null
    if (/(?:\bZ|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i.test(t)) return new Date(parsed)
    const d = new Date(parsed)
    wall = [
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
    ]
  }
  return wallTimeIn(wall, tz)
}

function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const u = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return (
    u.getUTCFullYear() === y &&
    u.getUTCMonth() === mo - 1 &&
    u.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60
  )
}

/** The instant whose wall clock in `tz` reads `wall`. */
function wallTimeIn(wall: [number, number, number, number, number, number], tz: string): Date {
  const [y, mo, d, h, mi, s] = wall
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  let instant = asUtc
  // Twice, for the rare wall time near a daylight-saving change.
  for (let i = 0; i < 2; i++) instant = asUtc - offsetMs(new Date(instant), tz)
  return new Date(instant)
}

function offsetMs(instant: Date, tz: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(zonedParts(instant, tz).offset)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000
}

/** Granola's summary without a first heading that only repeats the title or "Summary". */
function withoutLeadingHeading(summary: string, title: string): string {
  const m = /^#{1,3}\s+(.+)\n*/.exec(summary)
  if (!m) return summary
  const h = (m[1] ?? '').trim().toLowerCase()
  return h === title.toLowerCase() || h === 'summary' ? summary.slice(m[0].length).trim() : summary
}

function oneLine(s: string): string {
  return s
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
