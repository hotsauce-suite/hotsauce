// Reads Granola's data export in the browser (ARCHITECTURE §7.12): the CSV Granola emails from
// Settings → Profile → Generate CSV, or the .zip it sometimes comes in. Columns are found by
// name, since Granola doesn't document them and they have changed between versions.

import { readZipFiles } from '../notes/keepTakeout'

export interface GranolaMeeting {
  ref: string
  title: string
  date: string
  notes: string
  summary: string
  transcript: string
  attendees?: string[]
}

/** RFC 4180 CSV: quoted fields with "" escapes and line breaks, CRLF or LF, a BOM dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const COLUMNS = {
  ref: ['document_id', 'note_id', 'id', 'meeting_id'],
  title: ['document_title', 'title', 'meeting_title', 'name', 'heading'],
  date: [
    'document_created',
    'meeting_date',
    'date',
    'start_time',
    'started',
    'created_at',
    'created',
    'updated_at',
  ],
  notes: ['notes', 'my_notes', 'private_notes', 'notes_markdown', 'user_notes'],
  summary: ['summary', 'ai_summary', 'note_summary', 'enhanced_notes', 'summary_markdown'],
  transcript: ['transcript', 'full_transcript', 'transcript_text'],
  attendees: ['attendees', 'participants', 'people'],
} as const

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

/** Which column holds each field, by the header row; null when there is no transcript or title. */
export function granolaColumns(
  header: string[],
): Partial<Record<keyof typeof COLUMNS, number>> | null {
  const names = header.map(norm)
  const out: Partial<Record<keyof typeof COLUMNS, number>> = {}
  for (const [field, aliases] of Object.entries(COLUMNS) as Array<
    [keyof typeof COLUMNS, readonly string[]]
  >) {
    const i = aliases.map((a) => names.indexOf(a)).find((n) => n >= 0)
    if (i !== undefined) out[field] = i
  }
  const hasContent =
    out.transcript !== undefined || out.summary !== undefined || out.notes !== undefined
  return out.title !== undefined && out.date !== undefined && hasContent ? out : null
}

/** A stable id for a row with no Granola id, so importing again skips it. */
async function refFor(title: string, date: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${title}\n${date}`)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `h:${[...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** The meetings in one Granola CSV; none when its header isn't Granola's. */
export async function parseGranolaCsv(text: string): Promise<GranolaMeeting[]> {
  const [header, ...rows] = parseCsv(text)
  const cols = header ? granolaColumns(header) : null
  if (!cols) return []
  const at = (row: string[], i: number | undefined) => (i === undefined ? '' : (row[i] ?? ''))
  const out: GranolaMeeting[] = []
  for (const row of rows) {
    const title = at(row, cols.title).trim()
    const date = at(row, cols.date).trim()
    const id = at(row, cols.ref).trim()
    const attendees = attendeesOf(at(row, cols.attendees))
    // The server's limits, so one long meeting can't fail its whole batch.
    out.push({
      ref: id ? `g:${id.slice(0, 190)}` : await refFor(title, date),
      title: title.slice(0, 500),
      date: date.slice(0, 100),
      notes: at(row, cols.notes).slice(0, 200_000),
      summary: at(row, cols.summary).slice(0, 200_000),
      transcript: at(row, cols.transcript).slice(0, 2_000_000),
      ...(attendees.length > 0
        ? { attendees: attendees.slice(0, 200).map((a) => a.slice(0, 300)) }
        : {}),
    })
  }
  return out
}

/**
 * An attendees cell as names. Semicolons and lines separate people; commas do only when every
 * piece is an address, since "Shah, Priya" is one person.
 */
export function attendeesOf(cell: string): string[] {
  const out: string[] = []
  for (const part of cell.split(/[;\n]/)) {
    const pieces = part.split(/,(?![^<]*>)/).map((a) => a.trim())
    if (pieces.length > 1 && pieces.every((p) => p === '' || p.includes('@'))) out.push(...pieces)
    else out.push(part.trim())
  }
  return out.filter(Boolean)
}

/** Everything the member picked (.csv files and .zip files with CSVs inside) as meetings. */
export async function readGranolaExport(files: readonly File[]): Promise<GranolaMeeting[]> {
  const texts: string[] = []
  for (const file of files) {
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      for (const f of await readZipFiles(
        file,
        (n) => /\.csv$/i.test(n) && !n.startsWith('__MACOSX/'),
      )) {
        texts.push(f.text)
      }
    } else if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
      texts.push(await file.text())
    }
  }
  const out: GranolaMeeting[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    for (const m of await parseGranolaCsv(text)) {
      if (seen.has(m.ref)) continue
      seen.add(m.ref)
      out.push(m)
    }
  }
  return out
}

const encoder = new TextEncoder()

/** Batches the server takes: at most `max` meetings and about `maxBytes` of JSON (UTF-8 bytes) each. */
export function batches(
  meetings: GranolaMeeting[],
  max = 100,
  maxBytes = 6_000_000,
): GranolaMeeting[][] {
  const out: GranolaMeeting[][] = []
  let batch: GranolaMeeting[] = []
  let bytes = 0
  for (const m of meetings) {
    const size = encoder.encode(JSON.stringify(m)).length
    if (batch.length > 0 && (batch.length >= max || bytes + size > maxBytes)) {
      out.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(m)
    bytes += size
  }
  if (batch.length > 0) out.push(batch)
  return out
}
