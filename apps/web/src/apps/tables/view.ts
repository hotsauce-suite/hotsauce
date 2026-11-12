// Pure helpers for the grid (ARCHITECTURE §22.8): sorting and filtering the rows on screen,
// reading what a cell holds by its column type, and turning clipboard text into cells.

import type { ColumnType } from '@hearth/format'

export interface Sort {
  column: number
  dir: 'asc' | 'desc'
}

export interface Filter {
  column: number
  /** Rows whose value contains this (any case). */
  text: string
}

const NUMBER = /^-?\$?\d[\d,]*(\.\d+)?%?$|^-?\$?\.\d+%?$/

/** A value as a number when it reads as one (`1,234`, `$12.50`, `40%`), else null. */
export function asNumber(value: string): number | null {
  const v = value.trim()
  if (!NUMBER.test(v)) return null
  const n = Number(v.replace(/[$,%]/g, ''))
  return Number.isFinite(n) ? (v.endsWith('%') ? n / 100 : n) : null
}

/** Numbers by size, then everything else alphabetically; empty cells always last. */
export function compareValues(a: string, b: string): number {
  if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1
  const x = asNumber(a)
  const y = asNumber(b)
  if (x !== null && y !== null) return x - y
  if (x !== null) return -1
  if (y !== null) return 1
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * The data rows (1…rows-1; row 0 is the header row) in the order shown: filtered, then sorted.
 * `value(row, column)` is what a cell shows. Equal rows keep their order.
 */
export function viewRows(
  rows: number,
  value: (row: number, column: number) => string,
  sort: Sort | null,
  filters: readonly Filter[],
): number[] {
  let out = Array.from({ length: Math.max(0, rows - 1) }, (_, i) => i + 1)
  for (const f of filters) {
    const needle = f.text.trim().toLowerCase()
    if (needle) out = out.filter((r) => value(r, f.column).toLowerCase().includes(needle))
  }
  if (sort) {
    const sign = sort.dir === 'asc' ? 1 : -1
    out = out
      .map((r) => ({ r, v: value(r, sort.column) }))
      .sort((a, b) => {
        // Empty cells stay last whichever way the sort runs.
        if (a.v === '' || b.v === '') return compareValues(a.v, b.v) || a.r - b.r
        return sign * compareValues(a.v, b.v) || a.r - b.r
      })
      .map((x) => x.r)
  }
  return out
}

/** Whether a checkbox cell is ticked. */
export function isTicked(value: string): boolean {
  return /^(true|yes|y|x|1|✓)$/i.test(value.trim())
}

/** Whether a value can be opened as a link (http, https or mailto). */
export function linkHref(value: string, type: ColumnType): string | null {
  const v = value.trim()
  if (/^https?:\/\/\S+$/i.test(v)) return v
  if (type === 'person' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`
  return null
}

/**
 * Clipboard text as rows of cells: tab-separated (what Sheets, Excel and this grid copy), with
 * Sheets' quoting for cells holding tabs, newlines or quotes. One line without tabs is one cell.
 */
export function parseClipboard(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** Cells as clipboard text: tab-separated, quoted where a cell holds a tab, newline or quote. */
export function toClipboard(rows: readonly (readonly string[])[]): string {
  return rows
    .map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t'))
    .join('\n')
}
