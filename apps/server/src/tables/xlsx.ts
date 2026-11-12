// .xlsx in and out for Hearth Tables (ARCHITECTURE §22.5): just the first sheet's cells, as text,
// numbers, dates and formulas. Written fresh from the Office Open XML spreadsheet layout; the
// zip is fflate (MIT).

import {
  columnName,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  normalizeCells,
  parseA1,
  shiftFormula,
} from '@hearth/format'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** A workbook's XML may not unzip past this (a zip bomb stops here). */
const MAX_UNZIPPED_BYTES = 60 * 1024 * 1024
/** workbook.xml, its relationships and styles.xml are small in any real workbook. */
const MAX_SMALL_PART = 2 * 1024 * 1024
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

export class XlsxError extends Error {}

// ── reading ─────────────────────────────────────────────────────────────

/** The first sheet's cells as raw inputs (a formula as `=…`), row 1 first. */
export function readXlsx(bytes: Uint8Array): string[][] {
  let parts: Record<string, Uint8Array>
  try {
    let total = 0
    parts = unzipSync(bytes, {
      filter: (f) => {
        if (!/^(xl\/.*\.xml|xl\/_rels\/workbook\.xml\.rels)$/.test(f.name)) return false
        if (/^xl\/(media|drawings|charts|pivot)/.test(f.name)) return false
        total += f.originalSize
        if (total > MAX_UNZIPPED_BYTES) throw new XlsxError('This workbook is too big to read')
        return true
      },
    })
  } catch (err) {
    if (err instanceof XlsxError) throw err
    throw new XlsxError('That isn’t an Excel file this can read')
  }
  const xml = (name: string) => (parts[name] ? strFromU8(parts[name]) : null)
  // The small parts are read with regexes; a huge one is a trick, not a workbook.
  const small = (name: string) => {
    const text = xml(name)
    return text !== null && text.length <= MAX_SMALL_PART ? text : null
  }
  const sheetPath = firstSheetPath(small('xl/workbook.xml'), small('xl/_rels/workbook.xml.rels'))
  const sheet = xml(sheetPath) ?? xml('xl/worksheets/sheet1.xml')
  if (!sheet) throw new XlsxError('That workbook has no sheet that can be read')
  const shared = sharedStrings(xml('xl/sharedStrings.xml'))
  const dateStyles = dateStyleIndexes(small('xl/styles.xml'))

  const grid: string[][] = []
  const masters = new Map<string, { formula: string; row: number; column: number }>()
  for (const cell of elements(sheet, 'c')) {
    const attrs = cell.attrs
    const inner = cell.inner
    const at = parseA1(attr(attrs, 'r') ?? '')
    if (!at || at.row >= MAX_TABLE_ROWS || at.column >= MAX_TABLE_COLUMNS) continue
    const type = attr(attrs, 't')
    const style = Number(attr(attrs, 's') ?? 0)
    const f = nextElement(inner, 'f', 0)
    const v = nextElement(inner, 'v', 0)?.inner
    let input = ''
    if (f) {
      const fAttrs = f.attrs
      const text = decodeXml(f.inner)
      const si = attr(fAttrs, 'si')
      if (attr(fAttrs, 't') === 'shared' && si !== null) {
        if (text) masters.set(si, { formula: text, row: at.row, column: at.column })
        const master = masters.get(si)
        input = master
          ? `=${shiftFormula(master.formula, at.row - master.row, at.column - master.column)}`
          : v !== undefined
            ? decodeXml(v)
            : ''
      } else if (text) input = `=${text}`
    }
    if (!input) {
      if (type === 's') input = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') input = runs(inner)
      else if (type === 'b') input = v === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'str' || type === 'e') input = decodeXml(v ?? '')
      else if (v !== undefined) {
        const n = Number(v)
        input = dateStyles.has(style) && Number.isFinite(n) ? serialToDate(n) : v
      }
    }
    while (grid.length <= at.row) grid.push([])
    const row = grid[at.row] as string[]
    while (row.length <= at.column) row.push('')
    row[at.column] = input
  }
  return normalizeCells(grid)
}

function firstSheetPath(workbook: string | null, rels: string | null): string {
  const rid = workbook && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  if (!rid || !rels) return 'xl/worksheets/sheet1.xml'
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (attr(m[1] ?? '', 'Id') !== rid) continue
    const target = attr(m[1] ?? '', 'Target') ?? ''
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`
  }
  return 'xl/worksheets/sheet1.xml'
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return []
  return [...elements(xml, 'si')].map((si) => runs(si.inner))
}

/** The text of every `<t>` inside, phonetic runs left out. */
function runs(xml: string): string {
  let out = ''
  let from = 0
  for (const rph of elements(xml, 'rPh')) {
    out += xml.slice(from, rph.start)
    from = rph.end
  }
  const clean = out + xml.slice(from)
  return [...elements(clean, 't')].map((t) => decodeXml(t.inner)).join('')
}

interface XmlElement {
  start: number
  end: number
  attrs: string
  inner: string
}

/**
 * The next `<name …>…</name>` (or `<name …/>`) from `from`, found with indexOf so a hostile
 * file can't make it slow: every call moves forward, and an unclosed element ends the scan.
 * Fine for the elements read here, none of which nest inside themselves.
 */
function nextElement(xml: string, name: string, from: number): XmlElement | null {
  let i = from
  for (;;) {
    i = xml.indexOf(`<${name}`, i)
    if (i < 0) return null
    const next = xml[i + name.length + 1]
    if (
      next === '>' ||
      next === '/' ||
      next === ' ' ||
      next === '\t' ||
      next === '\n' ||
      next === '\r'
    )
      break
    i += name.length + 1
  }
  const gt = xml.indexOf('>', i)
  if (gt < 0) return null
  const selfClosing = xml[gt - 1] === '/'
  const attrs = xml.slice(i + name.length + 1, selfClosing ? gt - 1 : gt)
  if (selfClosing) return { start: i, end: gt + 1, attrs, inner: '' }
  const close = xml.indexOf(`</${name}>`, gt)
  if (close < 0) return null
  return { start: i, end: close + name.length + 3, attrs, inner: xml.slice(gt + 1, close) }
}

function* elements(xml: string, name: string): Generator<XmlElement> {
  let from = 0
  for (;;) {
    const el = nextElement(xml, name, from)
    if (!el) return
    yield el
    from = el.end
  }
}

/** Indexes into `cellXfs` whose number format is a date (built-in 14–22, 45–47, or a d/m/y code). */
function dateStyleIndexes(xml: string | null): Set<number> {
  const out = new Set<number>()
  if (!xml) return out
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    custom.set(
      Number(attr(m[1] ?? '', 'numFmtId')),
      decodeXml(attr(m[1] ?? '', 'formatCode') ?? ''),
    )
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1] ?? '', 'numFmtId') ?? 0)
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '')
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (code && /[dy]/i.test(code))) out.add(i)
    i++
  }
  return out
}

function serialToDate(serial: number): string {
  const d = new Date(EXCEL_EPOCH + Math.round(serial * DAY_MS))
  const date = d.toISOString().slice(0, 10)
  const time = d.toISOString().slice(11, 16)
  return Number.isInteger(serial) || time === '00:00' ? date : `${date} ${time}`
}

// ── writing ─────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** A one-sheet workbook: formulas with the values the grid shows, numbers, dates and text. */
export function writeXlsx(
  title: string,
  cells: readonly string[][],
  values: readonly string[][],
): Uint8Array {
  const rows: string[] = []
  for (const [r, row] of cells.entries()) {
    const out: string[] = []
    for (const [c, input] of row.entries()) {
      if (input === '') continue
      const ref = `${columnName(c)}${r + 1}`
      const value = values[r]?.[c] ?? ''
      if (input.startsWith('=') && input.length > 1) {
        const f = `<f>${escapeXml(input.slice(1))}</f>`
        out.push(
          NUMBER.test(value)
            ? `<c r="${ref}">${f}<v>${value}</v></c>`
            : `<c r="${ref}" t="str">${f}<v>${escapeXml(value)}</v></c>`,
        )
      } else if (NUMBER.test(input.trim())) {
        out.push(`<c r="${ref}"><v>${Number(input.trim())}</v></c>`)
      } else if (
        DATE.test(input.trim()) &&
        !Number.isNaN(Date.parse(`${input.trim()}T00:00:00Z`))
      ) {
        const serial = (Date.parse(`${input.trim()}T00:00:00Z`) - EXCEL_EPOCH) / DAY_MS
        out.push(`<c r="${ref}" s="1"><v>${serial}</v></c>`)
      } else {
        out.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(input)}</t></is></c>`,
        )
      }
    }
    if (out.length) rows.push(`<row r="${r + 1}">${out.join('')}</row>`)
  }
  const sheetName = escapeXml(sheetTitle(title))
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}

/** Excel sheet names: 31 characters, none of `\ / ? * [ ] :`. */
function sheetTitle(title: string): string {
  return (
    title
      .replace(/[\\/?*[\]:]/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet1'
  )
}

// ── XML bits ────────────────────────────────────────────────────────────

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  return m ? (m[1] ?? '') : null
}

function escapeXml(s: string): string {
  // Characters XML 1.0 can't hold are dropped.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the ones being removed
  const clean = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeXml(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => safeChar(Number.parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}
