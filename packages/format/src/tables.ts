// Hearth Tables (ARCHITECTURE §22): a table is `tables/<id>.md` in a space. Its frontmatter holds
// the title and each column's type; its body is the cells as one fenced `csv` block, row 1 the
// header row, each cell as typed (a formula stays `=C2*D2`). Written fresh for Hearth.

import { stringify as toYaml } from 'yaml'
import { z } from 'zod'
import { parseFrontmatter } from './frontmatter.js'

export const TABLES_FOLDER = 'tables'
/** Rows including the header row, and columns (A–AZ). */
export const MAX_TABLE_ROWS = 5001
export const MAX_TABLE_COLUMNS = 52
export const MAX_TABLE_CSV_BYTES = 2 * 1024 * 1024
export const MAX_CELL_CHARS = 10_000
export const MAX_COLUMN_OPTIONS = 50

export const COLUMN_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'choice',
  'person',
  'link',
] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const tablePath = (id: string) => `${TABLES_FOLDER}/${id}.md`
export const isTableId = (id: string) => ULID.test(id)

/** `tables/<id>.md` → the id; anything else null. */
export function tablePathId(path: string): string | null {
  const m = /^tables\/([0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(path)
  return m?.[1] ?? null
}

export const Column = z.looseObject({
  type: z.enum(COLUMN_TYPES).catch('text'),
  /** Choice columns: the options offered. */
  options: z.array(z.string().trim().min(1).max(200)).max(MAX_COLUMN_OPTIONS).optional(),
  /** Display width in pixels. */
  width: z.number().int().min(40).max(800).optional(),
})
export type Column = z.infer<typeof Column>

/** A table's frontmatter. Unknown keys pass through. */
export const TableFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('table'),
  title: z.string().trim().min(1).max(200),
  columns: z.array(Column).max(MAX_TABLE_COLUMNS).default([]),
  created: z.string().optional(),
  created_by: z.string().optional(),
  updated: z.string().optional(),
  updated_by: z.string().optional(),
})
export type TableFrontmatter = z.infer<typeof TableFrontmatter>

export class TableFormatError extends Error {}

// ── CSV (RFC 4180) ──────────────────────────────────────────────────────

/** Rows of cells. Quoted cells may hold commas, doubled quotes and newlines; CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  let any = false
  for (; i < text.length; i++) {
    const ch = text[i]
    any = true
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      any = false
    } else cell += ch
  }
  if (any || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const needsQuotes = /[",\r\n]|^\s|\s$/

/** CSV with LF line endings (one row per line in Git diffs), quoting only where needed. */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((r) => r.map((c) => (needsQuotes.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n')
}

/** A cell for a CSV someone opens in a spreadsheet: values starting `= + - @` can't run. */
export function safeCsvValue(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

// ── shape ───────────────────────────────────────────────────────────────

/** Every row the same width; trailing empty rows and columns dropped (row 1 always kept). */
export function normalizeCells(cells: readonly (readonly string[])[]): string[][] {
  let height = cells.length
  while (height > 1 && (cells[height - 1] ?? []).every((c) => c === '')) height--
  let width = 0
  for (let r = 0; r < height; r++) {
    const row = cells[r] ?? []
    for (let c = row.length - 1; c >= width; c--) {
      if (row[c] !== '') {
        width = c + 1
        break
      }
    }
  }
  width = Math.max(width, 1)
  const out: string[][] = []
  for (let r = 0; r < Math.max(height, 1); r++) {
    const row = cells[r] ?? []
    out.push(Array.from({ length: width }, (_, c) => row[c] ?? ''))
  }
  return out
}

/** Columns padded with text columns (or cut) to `width`. */
export function fitColumns(columns: readonly Column[], width: number): Column[] {
  return Array.from({ length: width }, (_, i) => columns[i] ?? { type: 'text' as const })
}

/** What's wrong with a table's size or columns, or null. */
export function tableProblem(
  columns: readonly Column[],
  cells: readonly string[][],
): string | null {
  if (cells.length > MAX_TABLE_ROWS) {
    return `A table can have ${MAX_TABLE_ROWS - 1} rows at most`
  }
  const width = Math.max(0, ...cells.map((r) => r.length))
  if (width > MAX_TABLE_COLUMNS || columns.length > MAX_TABLE_COLUMNS) {
    return `A table can have ${MAX_TABLE_COLUMNS} columns at most`
  }
  for (const row of cells) {
    for (const c of row) if (c.length > MAX_CELL_CHARS) return 'A cell is too long'
  }
  if (new TextEncoder().encode(writeCsv(cells)).length > MAX_TABLE_CSV_BYTES) {
    return 'This table is too big (2 MB at most)'
  }
  for (const [i, col] of columns.entries()) {
    if (col.type === 'choice') {
      const opts = col.options ?? []
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) {
        return `Column ${columnName(i)} has the same option twice`
      }
    }
  }
  return null
}

// ── the file ────────────────────────────────────────────────────────────

/** The file: frontmatter, then the cells in a fence longer than any backtick run inside. */
export function tableFile(fm: TableFrontmatter, cells: readonly (readonly string[])[]): string {
  const data = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined))
  const csv = writeCsv(cells)
  const longest = Math.max(0, ...[...csv.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `---\n${toYaml(data)}---\n${fence}csv\n${csv}\n${fence}\n`
}

/** A table file's frontmatter and cells. Throws `TableFormatError` when it isn't one. */
export function parseTableFile(content: string): { fm: TableFrontmatter; cells: string[][] } {
  const { data, body } = parseFrontmatter(content)
  const fm = TableFrontmatter.safeParse(data)
  if (!fm.success) throw new TableFormatError('Not a table file')
  const open = /^(`{3,})csv[ \t]*$/m.exec(body)
  if (!open) return { fm: fm.data, cells: [['']] }
  const start = open.index + open[0].length + 1
  const fence = open[1] ?? '```'
  const close = new RegExp(`^${fence}[ \\t]*$`, 'm')
  const rest = body.slice(start)
  const end = close.exec(rest)
  const csv = (end ? rest.slice(0, end.index) : rest).replace(/\n$/, '')
  return { fm: fm.data, cells: normalizeCells(parseCsv(csv)) }
}

/** What a plain (non-formula) cell shows: as typed, without a leading `'` that keeps it text. */
export function plainText(input: string): string {
  return input.startsWith("'") ? input.slice(1) : input
}

// ── A1 addresses ────────────────────────────────────────────────────────

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** `B3` → { row: 2, column: 1 } (0-based); anything else null. */
export function parseA1(address: string): { row: number; column: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(address.trim())
  if (!m) return null
  let col = 0
  for (const ch of (m[1] ?? '').toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, column: col - 1 }
}

/**
 * A formula's relative references moved by (rows, columns), as when a formula is copied to another
 * cell; `$` parts stay put, text in quotes is left alone, and a reference pushed off the sheet is
 * `#REF!`.
 */
export function shiftFormula(formula: string, rows: number, columns: number): string {
  return formula.replace(
    /("(?:[^"]|"")*")|(?<![A-Za-z0-9_.!'])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g,
    (whole, str, colAbs, col, rowAbs, row) => {
      if (str) return str
      const at = parseA1(`${col}${row}`)
      if (!at) return whole
      const c = colAbs ? at.column : at.column + columns
      const r = rowAbs ? at.row : at.row + rows
      if (c < 0 || r < 0) return '#REF!'
      return `${colAbs}${columnName(c)}${rowAbs}${r + 1}`
    },
  )
}
