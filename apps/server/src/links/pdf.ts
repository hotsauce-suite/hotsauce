// A PDF's readable copy (docs/PLAN-links-pdfs.md R3): pdf.js (through unpdf, MIT; pdf.js is
// Apache-2.0) gives each page's text with its position and size, and the lines are put back
// into paragraphs and headings: lines rejoined, words split at a line's end mended, page numbers
// and running heads dropped. The layout part (`pdfLinesToMarkdown`) is pure.

import { MAX_LINK_BODY, oneLine, wordCount } from '@hotsauce/format'

/** PDFs bigger than this aren't kept (the same limit Files reads text up to). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024
/** Pages read for the copy; a longer PDF's copy stops here. */
const MAX_PAGES = 600
/** Reading stops here: pdf.js runs on the main thread. */
const READ_TIMEOUT_MS = 60_000

export interface PdfLine {
  text: string
  /** Distance from the page's bottom, in PDF units. */
  y: number
  x: number
  /** The font size. */
  size: number
}

export interface ReadablePdf {
  /** The PDF's own title, else its biggest early line; '' when neither. */
  title: string
  markdown: string
  words: number
  pages: number
}

/** True when the bytes start like a PDF (`%PDF-`, allowing a little junk before it). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * The readable copy of a PDF. One PDF at a time, at most a minute; throws when pdf.js can't
 * open it. A PDF with no text (scanned) gives an empty copy.
 */
export function readPdf(bytes: Uint8Array): Promise<ReadablePdf> {
  const run = queue.then(() => withTimeout(readNow(bytes), READ_TIMEOUT_MS))
  queue = run.catch(() => {})
  return run
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Reading the PDF took too long')), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

interface TextItem {
  str: string
  transform: number[]
  height: number
  hasEOL?: boolean
}

async function readNow(bytes: Uint8Array): Promise<ReadablePdf> {
  const { getDocumentProxy } = await import('unpdf')
  // pdf.js takes ownership of the buffer it's given; hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const pageCount = Math.min(pdf.numPages, MAX_PAGES)
    const pages: PdfLine[][] = []
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      pages.push(linesOf(content.items as TextItem[]))
      page.cleanup()
    }
    let infoTitle = ''
    try {
      const meta = await pdf.getMetadata()
      const t = (meta.info as { Title?: unknown } | undefined)?.Title
      infoTitle = typeof t === 'string' ? usableTitle(t) : ''
    } catch {}
    const markdown = pdfLinesToMarkdown(pages)
    return {
      title: infoTitle || titleFromLines(pages[0] ?? []),
      markdown,
      words: wordCount(markdown),
      pages: pdf.numPages,
    }
  } finally {
    await pdf.cleanup()
  }
}

/** pdf.js text items as lines: a new line at each end-of-line mark or a jump in height. */
function linesOf(items: TextItem[]): PdfLine[] {
  const lines: PdfLine[] = []
  let cur: PdfLine | null = null
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const t = item.transform ?? [1, 0, 0, 1, 0, 0]
    const size = Math.abs(item.height || Math.hypot(t[2] ?? 0, t[3] ?? 0)) || 0
    const x = t[4] ?? 0
    const y = t[5] ?? 0
    if (cur && item.str.trim() && Math.abs(cur.y - y) > Math.max(cur.size, size) * 0.6) {
      lines.push(cur)
      cur = null
    }
    if (!cur) {
      if (!item.str.trim() && !item.hasEOL) continue
      cur = { text: '', y, x, size }
    }
    cur.text += item.str
    if (item.str.trim()) cur.size = Math.max(cur.size, size)
    if (item.hasEOL) {
      lines.push(cur)
      cur = null
    }
  }
  if (cur) lines.push(cur)
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text)
}

/** A PDF's own title, unless it's a file name or a tool's leftovers. */
function usableTitle(raw: string): string {
  const t = oneLine(raw)
  if (!t || t.length < 4 || t.length > 300) return ''
  if (/^(microsoft (word|powerpoint) - |untitled)|\.(docx?|pptx?|tex|dvi|pdf|indd)$/i.test(t))
    return ''
  return t
}

function titleFromLines(lines: PdfLine[]): string {
  const early = lines.slice(0, 20).filter((l) => l.text.length >= 4 && l.text.length <= 200)
  if (early.length === 0) return ''
  const biggest = Math.max(...early.map((l) => l.size))
  const at = early.findIndex((l) => l.size === biggest)
  // A title often runs over two lines in the same size.
  const parts = [early[at]?.text ?? '']
  const next = early[at + 1]
  if (
    next &&
    Math.abs(next.size - biggest) < 0.5 &&
    parts[0] &&
    parts[0].length + next.text.length < 250
  ) {
    parts.push(next.text)
  }
  return oneLine(parts.join(' '))
}

const HEADING_WORDS =
  /^(abstract|introduction|background|methods?|materials and methods|results|discussion|conclusions?|summary|references|bibliography|acknowledge?ments?|appendix(?: [a-z0-9]+)?|supplementary (?:material|information)|related work)$/i
const NUMBERED_HEADING = /^((\d+(\.\d+){0,3}\.?)|([IVX]+\.)|([A-Z]\.(\d+\.?)*))\s+\S/

/**
 * Lines of each page to Markdown (pure): paragraphs where the gap between lines grows, headings
 * for bigger or numbered short lines, page numbers and lines repeated at the top or bottom of
 * most pages dropped.
 */
export function pdfLinesToMarkdown(pages: PdfLine[][]): string {
  const repeated = runningHeads(pages)
  const all = pages.flat()
  const body = bodySize(all)
  const blocks: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length > 0) blocks.push(escapeBlock(joinLines(para)))
    para = []
  }
  for (const lines of pages) {
    const kept = lines.filter((l, i) => {
      if (/^\d{1,4}$/.test(l.text) || /^page \d+( of \d+)?$/i.test(l.text)) return false
      const edge = i < 2 || i >= lines.length - 2
      return !(edge && repeated.has(headKey(l.text)))
    })
    const gap = typicalGap(kept, body)
    let prev: PdfLine | null = null
    let lastHeading: PdfLine | null = null
    for (const line of kept) {
      if (isHeading(line, body)) {
        flush()
        const text = escapeInline(line.text.replace(/\.$/, ''))
        // A heading set over two lines in the same size is one heading.
        if (lastHeading && Math.abs(lastHeading.size - line.size) < 0.5 && blocks.length > 0) {
          blocks[blocks.length - 1] += ` ${text}`
        } else blocks.push(`## ${text}`)
        lastHeading = line
        prev = null
        continue
      }
      lastHeading = null
      if (prev) {
        const down = prev.y - line.y
        const jump = down > gap * 1.45 + 0.5
        // A new column or page starts higher up: the paragraph carries on unless it had ended.
        const newColumn = down < -prev.size
        const indented = line.x > prev.x + body * 1.2 && down > 0 && down <= gap * 1.45 + 0.5
        const ended = /[.!?:"”)]$/.test(prev.text)
        if (jump || (indented && ended) || (newColumn && ended && startsSentence(line.text))) {
          flush()
        }
      }
      para.push(line.text)
      prev = line
    }
    // A page break ends a paragraph only when its last line ended a sentence.
    const last = para.at(-1)
    if (last && /[.!?:]$/.test(last)) flush()
  }
  flush()
  let out = ''
  for (const block of blocks) {
    const next = out ? `${out}\n\n${block}` : block
    if (next.length > MAX_LINK_BODY) break
    out = next
  }
  return out
}

function startsSentence(text: string): boolean {
  return /^[A-Z0-9"“(]/.test(text)
}

function isHeading(line: PdfLine, body: number): boolean {
  const t = line.text
  if (t.length > 120 || /[,;]$/.test(t)) return false
  if (HEADING_WORDS.test(t.replace(/[.:]$/, ''))) return true
  const words = t.split(' ').length
  if (line.size >= body * 1.15 && words <= 16 && /\p{L}/u.test(t)) return true
  return (
    NUMBERED_HEADING.test(t) &&
    words <= 12 &&
    !/[.]$/.test(t.replace(/^\S+\s/, '')) &&
    /^\S+\s+\p{Lu}/u.test(t) &&
    line.size >= body * 0.95
  )
}

/** Rejoins a paragraph's lines, mending a word split at a line's end ("trans-" + "lation"). */
function joinLines(lines: string[]): string {
  let out = ''
  for (const line of lines) {
    if (!out) out = line
    else if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line
    else out = `${out} ${line}`
  }
  return out
}

/** The most common font size, by characters. */
function bodySize(lines: PdfLine[]): number {
  const counts = new Map<number, number>()
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2
    counts.set(k, (counts.get(k) ?? 0) + l.text.length)
  }
  let best = 10
  let most = -1
  for (const [k, n] of counts) {
    if (n > most) {
      best = k
      most = n
    }
  }
  return best || 10
}

/** The usual distance between two body lines on a page. */
function typicalGap(lines: PdfLine[], body: number): number {
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1] as PdfLine
    const b = lines[i] as PdfLine
    const d = a.y - b.y
    if (d > 0 && d < body * 3 && Math.abs(a.size - body) < 1 && Math.abs(b.size - body) < 1) {
      gaps.push(d)
    }
  }
  if (gaps.length === 0) return body * 1.2
  gaps.sort((p, q) => p - q)
  return gaps[Math.floor(gaps.length / 2)] as number
}

function headKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ')
}

/** Text at the top or bottom of at least half the pages (and three): running heads and feet. */
function runningHeads(pages: PdfLine[][]): Set<string> {
  const counts = new Map<string, number>()
  for (const lines of pages) {
    const seen = new Set<string>()
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      // A sentence is the page's own text, however alike it looks from page to page.
      if (!/[.!?]$/.test(l.text)) seen.add(headKey(l.text))
    }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const need = Math.max(3, Math.ceil(pages.length / 2))
  return new Set([...counts].filter(([, n]) => n >= need).map(([k]) => k))
}

/** Markdown's own characters as text, so the copy shows the PDF's words as they are. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>|~])/g, '\\$1')
}

function escapeBlock(text: string): string {
  return escapeInline(text)
    .replace(/^(\d+)([.)]\s)/, '$1\\$2')
    .replace(/^(#{1,6}\s|[-+*]\s|={3,}|-{3,})/, '\\$1')
}
