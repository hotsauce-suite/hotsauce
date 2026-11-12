import { readFile } from 'node:fs/promises'
import { fileExtension, MAX_FILE_TEXT_CHARS } from '@hearth/format'
import { strFromU8, unzipSync } from 'fflate'

/** Files bigger than this aren't read for text: a 2 GB video has none worth the memory. */
export const MAX_EXTRACT_BYTES = 100 * 1024 * 1024
/** An Office file's XML parts, unzipped, may not exceed this (a zip bomb stops here). */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
/** pdf.js runs on the server's main thread; bigger PDFs are stored without their text. */
const MAX_PDF_BYTES = 50 * 1024 * 1024
/** Reading stops here and the file is stored with `text: failed`. */
const EXTRACT_TIMEOUT_MS = 60_000

export type Extracted = { status: 'extracted'; text: string } | { status: 'none' | 'failed' }

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * The searchable text of a stored file (ARCHITECTURE §18.3): PDF through pdf.js (unpdf), Word,
 * PowerPoint and Excel by reading their XML, text files as they are. Never throws.
 */
export function extractText(
  file: string,
  name: string,
  mime: string,
  size: number,
): Promise<Extracted> {
  // One file at a time, so several big uploads finishing together don't stack up memory.
  const run = queue.then(() => withTimeout(read(file, name, mime, size), EXTRACT_TIMEOUT_MS))
  queue = run.then(
    () => {},
    () => {},
  )
  return run
}

let queue: Promise<void> = Promise.resolve()

function withTimeout(work: Promise<Extracted>, ms: number): Promise<Extracted> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<Extracted>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed' }), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

async function read(file: string, name: string, mime: string, size: number): Promise<Extracted> {
  if (size > MAX_EXTRACT_BYTES) return { status: 'none' }
  const ext = fileExtension(name)
  const kind =
    mime === 'application/pdf'
      ? 'pdf'
      : ext === 'docx' || ext === 'pptx' || ext === 'xlsx'
        ? ext
        : TEXT_TYPES.has(mime)
          ? 'text'
          : null
  if (kind === null) return { status: 'none' }
  if (kind === 'pdf' && size > MAX_PDF_BYTES) return { status: 'none' }
  try {
    const bytes = new Uint8Array(await readFile(file))
    const text =
      kind === 'pdf'
        ? await pdfText(bytes)
        : kind === 'text'
          ? new TextDecoder('utf-8', { fatal: false }).decode(
              bytes.subarray(0, MAX_FILE_TEXT_CHARS * 4),
            )
          : officeText(bytes, kind)
    const trimmed = tidy(text)
    return trimmed ? { status: 'extracted', text: trimmed } : { status: 'none' }
  } catch {
    return { status: 'failed' }
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText: unpdfText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes)
  try {
    const { text } = await unpdfText(pdf, { mergePages: false })
    return (text as string[]).join('\n\n')
  } finally {
    await pdf.cleanup()
  }
}

/** Text from the XML inside a .docx, .pptx or .xlsx. */
export function officeText(bytes: Uint8Array, kind: 'docx' | 'pptx' | 'xlsx'): string {
  let total = 0
  const parts = unzipSync(bytes, {
    filter: (f) => {
      const wanted =
        kind === 'docx'
          ? /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(f.name)
          : kind === 'pptx'
            ? /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f.name)
            : /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(f.name)
      if (!wanted) return false
      total += f.originalSize
      if (total > MAX_UNZIPPED_BYTES) throw new Error('Too large unzipped')
      return true
    },
  })
  const names = Object.keys(parts).sort(byNumber)
  const xml = (n: string) => strFromU8(parts[n] as Uint8Array)
  if (kind === 'docx') {
    return names.map((n) => paragraphs(xml(n), 'w:p', 'w:t')).join('\n\n')
  }
  if (kind === 'pptx') {
    return names
      .filter((n) => n.startsWith('ppt/slides/'))
      .map((n, i) => `Slide ${i + 1}\n${paragraphs(xml(n), 'a:p', 'a:t')}`)
      .join('\n\n')
  }
  // Excel: shared strings hold most text; inline strings and numbers live in the sheets.
  const out: string[] = []
  if (parts['xl/sharedStrings.xml']) out.push(paragraphs(xml('xl/sharedStrings.xml'), 'si', 't'))
  for (const n of names.filter((n) => n.startsWith('xl/worksheets/'))) {
    const inline = paragraphs(xml(n), 'is', 't')
    if (inline) out.push(inline)
  }
  return out.join('\n')
}

/** Each `<para>` as one line: the text of its `<run>` elements joined. */
function paragraphs(xml: string, para: string, run: string): string {
  const lines: string[] = []
  let length = 0
  const paraRe = new RegExp(`<${para}[\\s>][\\s\\S]*?</${para}>`, 'g')
  const runRe = new RegExp(`<${run}(?:\\s[^>]*)?>([\\s\\S]*?)</${run}>`, 'g')
  for (const p of xml.match(paraRe) ?? []) {
    let line = ''
    for (const m of p.matchAll(runRe)) line += decodeXml(m[1] ?? '')
    if (line.trim()) {
      lines.push(line)
      length += line.length + 1
    }
    if (length > MAX_FILE_TEXT_CHARS) break
  }
  return lines.join('\n')
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
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

/** `slide10` after `slide9`. */
function byNumber(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

function tidy(text: string): string {
  // Cut before the regexes run: a little over the cap leaves room for what they remove.
  return text
    .slice(0, MAX_FILE_TEXT_CHARS * 2)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_FILE_TEXT_CHARS)
}
