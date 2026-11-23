// PDF tools in Files (docs/PLAN-pdf-tools.md): pure functions over PDF bytes, with pdf-lib (MIT).
// Every result is a new document built from the pages it keeps, so nothing from a page that was
// left out (or redacted) stays in the file. Nothing here touches the DOM; the browser parts
// (drawing pages, reading words, re-encoding pictures) are passed in.

import {
  decodePDFRawStream,
  degrees,
  EncryptedPDFError,
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib'

/** A PDF this tool can't open or change, with words to show the member. */
export class PdfToolError extends Error {}

const LOCKED = 'This PDF is locked with a password, so it can’t be changed here.'

/** Opens a PDF for changing, or throws a PdfToolError in plain words. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    if (err instanceof EncryptedPDFError) throw new PdfToolError(LOCKED)
    throw new PdfToolError('This file couldn’t be read as a PDF.')
  }
}

/**
 * Drops every object nothing in the document points to any more, so a page that was left out
 * (or rebuilt as a picture) can't linger in the file. A page that isn't one of the document's own
 * pages is never followed, whatever points at it (a form field, a link, a bead), so it goes too;
 * what pointed at it reads as nothing.
 */
export function prune(context: PDFContext, ownPages?: PDFRef[]): void {
  const own = ownPages ? new Set(ownPages.map(String)) : null
  const seen = new Set<string>()
  const walk = (value: unknown): void => {
    if (value instanceof PDFRef) {
      const key = String(value)
      if (seen.has(key)) return
      const target = context.lookup(value)
      if (own && target instanceof PDFDict && !own.has(key)) {
        const type = target.lookup(PDFName.of('Type'))
        if (type === PDFName.of('Page')) return
      }
      seen.add(key)
      walk(target)
    } else if (value instanceof PDFDict) {
      for (const [, v] of value.entries()) walk(v)
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) walk(value.get(i))
    } else if (value instanceof PDFStream) {
      walk(value.dict)
    }
  }
  walk(context.trailerInfo.Root)
  walk(context.trailerInfo.Info)
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(String(ref))) context.delete(ref)
  }
}

const RESOURCE_KINDS = [
  'XObject',
  'Font',
  'ExtGState',
  'Pattern',
  'Shading',
  'ColorSpace',
  'Properties',
]

/** Every name a content stream mentions, or null when it can't be read. */
function namesIn(streams: PDFStream[]): Set<string> | null {
  const names = new Set<string>()
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) return null
    let bytes: Uint8Array
    try {
      bytes = decodePDFRawStream(stream).decode()
    } catch {
      return null
    }
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    for (const m of text.matchAll(/\/([^\s/[\]<>(){}%]+)/g)) {
      const raw = m[1] as string
      names.add(
        raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      )
    }
  }
  return names
}

function streamsOf(contents: unknown, context: PDFContext): PDFStream[] {
  const value = contents instanceof PDFRef ? context.lookup(contents) : contents
  if (value instanceof PDFStream) return [value]
  if (value instanceof PDFArray) {
    return value
      .asArray()
      .map((v) => (v instanceof PDFRef ? context.lookup(v) : v))
      .filter((v): v is PDFStream => v instanceof PDFStream)
  }
  return []
}

/**
 * Resources that list only what `streams` draw with. Producers often share one list across every
 * page, so a kept page would otherwise carry another page's pictures and forms into the new file.
 * Forms and patterns it keeps get the same treatment for their own drawing.
 */
function trimResources(
  context: PDFContext,
  resources: PDFDict | undefined,
  streams: PDFStream[],
  done: Set<PDFStream>,
): PDFDict | undefined {
  if (!resources) return resources
  const names = namesIn(streams)
  if (!names) return resources
  const out = context.obj({}) as PDFDict
  for (const [key, value] of resources.entries()) {
    const kind = key.decodeText()
    if (!RESOURCE_KINDS.includes(kind)) {
      out.set(key, value)
      continue
    }
    const list = resources.lookup(key)
    if (!(list instanceof PDFDict)) continue
    const kept = context.obj({}) as PDFDict
    for (const [name, entry] of list.entries()) {
      if (!names.has(name.decodeText())) continue
      kept.set(name, entry)
      const target = entry instanceof PDFRef ? context.lookup(entry) : entry
      if (target instanceof PDFStream && !done.has(target)) {
        done.add(target)
        const own = target.dict.lookup(PDFName.of('Resources'))
        if (own instanceof PDFDict) {
          const trimmed = trimResources(context, own, [target], done)
          if (trimmed) target.dict.set(PDFName.of('Resources'), trimmed)
        }
      }
    }
    out.set(key, kept)
  }
  return out
}

/**
 * Gets `doc` ready for copying only the pages `keep` (0-based): each kept page lists only the
 * resources it draws with, and loses every annotation tie to another page (links and actions that
 * jump to a page left out, form fields shared with other pages, annotations that belong to another
 * page, article beads). pdf-lib copies everything a page can reach, so this is what keeps a page
 * that was left out (or redacted) out of the new file.
 */
function isolatePages(doc: PDFDocument, keep: number[]): void {
  const context = doc.context
  const all = doc.getPages()
  const kept = new Set(keep.map((i) => String(all[i]?.ref)))
  const left = new Set(all.map((p) => String(p.ref)).filter((r) => !kept.has(r)))
  const reachesLeftOut = (value: unknown, seen = new Set<unknown>()): boolean => {
    if (seen.has(value)) return false
    seen.add(value)
    if (value instanceof PDFRef) {
      if (left.has(String(value))) return true
      return reachesLeftOut(context.lookup(value), seen)
    }
    if (value instanceof PDFArray) return value.asArray().some((v) => reachesLeftOut(v, seen))
    if (value instanceof PDFDict) {
      for (const [k, v] of value.entries()) {
        // A page's own parent isn't a jump; P is checked on its own.
        if (k === PDFName.of('Parent') || k === PDFName.of('P')) continue
        if (reachesLeftOut(v, seen)) return true
      }
    }
    return false
  }
  const done = new Set<PDFStream>()
  for (const index of keep) {
    const page = all[index]
    if (!page) continue
    const node = page.node
    node.delete(PDFName.of('B'))
    const trimmed = trimResources(
      context,
      node.Resources(),
      streamsOf(node.get(PDFName.of('Contents')), context),
      done,
    )
    if (trimmed) node.set(PDFName.of('Resources'), trimmed)
    const annots = node.Annots()
    if (!annots) continue
    const fresh = context.obj([]) as PDFArray
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i)
      const annot = annots.lookup(i)
      if (!(annot instanceof PDFDict)) continue
      const owner = annot.get(PDFName.of('P'))
      if (owner instanceof PDFRef && String(owner) !== String(page.ref)) continue
      // A form field's other widgets (and its value) live on other pages; the widget stays as
      // a plain picture of itself.
      annot.delete(PDFName.of('Parent'))
      annot.delete(PDFName.of('IRT'))
      if (
        reachesLeftOut(annot.get(PDFName.of('Dest'))) ||
        reachesLeftOut(annot.get(PDFName.of('A')))
      ) {
        continue
      }
      if (reachesLeftOut(annot.get(PDFName.of('Popup')))) annot.delete(PDFName.of('Popup'))
      fresh.push(ref)
    }
    node.set(PDFName.of('Annots'), fresh)
  }
}

/** How many pages, without changing anything. */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await openPdf(bytes)).getPageCount()
}

/** One page of the result: page `index` (0-based) of source `source`, turned `rotate` more degrees. */
export interface PagePick {
  source: number
  index: number
  /** Extra clockwise turn: 0, 90, 180 or 270. */
  rotate?: number
}

const turn = (a: number) => (((Math.round(a / 90) * 90) % 360) + 360) % 360

/**
 * A new PDF of the picked pages, in order (Pages: combine, reorder, rotate, remove; Split). The
 * first source's title carries over.
 */
export async function assemble(sources: Uint8Array[], picks: PagePick[]): Promise<Uint8Array> {
  if (picks.length === 0) throw new PdfToolError('Keep at least one page.')
  const docs = await Promise.all(sources.map(openPdf))
  const out = await PDFDocument.create()
  const title = docs[0]?.getTitle()
  if (title) out.setTitle(title)
  // copyPages once per source, for the pages it gives, so shared resources are copied once.
  const wanted = new Map<number, number[]>()
  for (const p of picks) {
    const doc = docs[p.source]
    if (!doc || p.index < 0 || p.index >= doc.getPageCount()) {
      throw new PdfToolError('A page that was picked isn’t in the PDF any more.')
    }
    const list = wanted.get(p.source) ?? []
    if (!list.includes(p.index)) list.push(p.index)
    wanted.set(p.source, list)
  }
  const copied = new Map<string, PDFPage>()
  for (const [source, indices] of wanted) {
    const doc = docs[source] as PDFDocument
    isolatePages(doc, indices)
    const pages = await out.copyPages(doc, indices)
    for (const [i, index] of indices.entries()) {
      copied.set(`${source}:${index}`, pages[i] as PDFPage)
    }
  }
  const used = new Set<string>()
  for (const p of picks) {
    const key = `${p.source}:${p.index}`
    let page = copied.get(key) as PDFPage
    // The same page twice needs its own copy (its links to other pages then copy those pages
    // again, but prune drops them).
    if (used.has(key)) {
      ;[page] = (await out.copyPages(docs[p.source] as PDFDocument, [p.index])) as [PDFPage]
    }
    used.add(key)
    const extra = turn(p.rotate ?? 0)
    if (extra) page.setRotation(degrees(turn(page.getRotation().angle + extra)))
    out.addPage(page)
  }
  prune(
    out.context,
    out.getPages().map((p) => p.ref),
  )
  return out.save({ useObjectStreams: true })
}

/**
 * Pages from text like "1-3, 5, 8-" (1-based, inclusive; "8-" runs to the end). Each part becomes
 * one file. Throws a PdfToolError naming what's wrong.
 */
export function parseRanges(text: string, pages: number): number[][] {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new PdfToolError('Type the pages to keep, like 1-3, 5.')
  return parts.map((part) => {
    const m = /^(\d+)?\s*(?:(-|–|to)\s*(\d+)?)?$/i.exec(part)
    if (!m || (!m[1] && !m[3])) throw new PdfToolError(`“${part}” isn’t a page or a range.`)
    const from = m[1] ? Number(m[1]) : 1
    const to = m[2] ? (m[3] ? Number(m[3]) : pages) : from
    if (from < 1 || to < 1) throw new PdfToolError(`“${part}”: pages start at 1.`)
    if (from > pages || to > pages) {
      throw new PdfToolError(
        `“${part}” goes past the last page; this PDF has ${pages} page${pages === 1 ? '' : 's'}.`,
      )
    }
    if (to < from) throw new PdfToolError(`“${part}” runs backwards.`)
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i)
  })
}

/** "1-3", "5": how a range reads in a file name (0-based pages in). */
export function rangeLabel(pages: number[]): string {
  const first = (pages[0] ?? 0) + 1
  const last = (pages[pages.length - 1] ?? 0) + 1
  return first === last ? `page ${first}` : `pages ${first}-${last}`
}

/** "Contract.pdf" + "redacted" → "Contract (redacted).pdf". */
export function resultName(original: string, what: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'Document'
  return `${base} (${what}).pdf`
}

// ---------------------------------------------------------------------------------------------
// Page geometry. Pages are drawn (and read) as they look on screen, with their rotation; the
// file keeps them unrotated. These turn a spot on the picture into a point in the page's own
// space.

export interface PageBox {
  x: number
  y: number
  width: number
  height: number
  /** The page's own clockwise rotation: 0, 90, 180 or 270. */
  rotation: number
}

export function pageBox(page: PDFPage): PageBox {
  const box = page.getCropBox()
  return { ...box, rotation: turn(page.getRotation().angle) }
}

/** A spot on the page as shown (fractions from its top-left) in the page's own points. */
export function toPagePoint(box: PageBox, fx: number, fy: number): { x: number; y: number } {
  const { width: w, height: h } = box
  let x: number
  let y: number
  switch (box.rotation) {
    case 90:
      x = fy * w
      y = fx * h
      break
    case 180:
      x = (1 - fx) * w
      y = fy * h
      break
    case 270:
      x = (1 - fy) * w
      y = (1 - fx) * h
      break
    default:
      x = fx * w
      y = (1 - fy) * h
  }
  return { x: box.x + x, y: box.y + y }
}

/** How big the page looks on screen, in points (width and height swap when it's turned). */
export function shownSize(box: PageBox): { width: number; height: number } {
  return box.rotation % 180 === 0
    ? { width: box.width, height: box.height }
    : { width: box.height, height: box.width }
}

// ---------------------------------------------------------------------------------------------
// Invisible text (Make searchable, R5; and redacted pages, R7).

/** A line or word read off a page picture, as fractions of the picture from its top-left. */
export interface ReadText {
  text: string
  x: number
  y: number
  width: number
  height: number
}

/** Helvetica's encoding (WinAnsi) can't hold every letter; others become a close one or "?". */
export function winAnsi(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[\t\n\r ]/g, ' ')
    .replace(/[^\x20-\x7E¡-ÿ]/g, '?')
}

function drawInvisible(page: PDFPage, font: PDFFont, words: ReadText[]): void {
  // The page's own drawing may leave its coordinates changed; fence it in so the words land
  // where they're meant to.
  const context = page.doc.context
  page.node.wrapContentStreams(
    context.register(context.flateStream('q\n')),
    context.register(context.flateStream('\nQ')),
  )
  const box = pageBox(page)
  const shown = shownSize(box)
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
  for (const word of words) {
    const text = winAnsi(word.text).trim()
    if (!text) continue
    const height = word.height * shown.height
    const width = word.width * shown.width
    const unit = font.widthOfTextAtSize(text, 1)
    if (unit <= 0 || height <= 0 || width <= 0) continue
    // As wide as the word on the picture, so selecting it highlights the right place.
    const size = Math.max(1, Math.min(width / unit, height * 1.5))
    // The baseline sits a little above the bottom of the box.
    const at = toPagePoint(box, word.x, word.y + word.height * 0.82)
    page.drawText(text, { x: at.x, y: at.y, size, font, rotate: degrees(box.rotation) })
  }
  page.pushOperators(popGraphicsState())
}

/**
 * Adds invisible text over the given pages (0-based) so the words can be searched, selected and
 * copied while the page looks the same.
 */
export async function addTextLayer(
  bytes: Uint8Array,
  pages: Map<number, ReadText[]>,
): Promise<Uint8Array> {
  const doc = await openPdf(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const [index, words] of pages) {
    const page = doc.getPage(index)
    if (words.length) drawInvisible(page, font, words)
  }
  return doc.save({ useObjectStreams: true })
}

/** A page drawn as a picture, for a page that is rebuilt (redaction, R7). */
export interface PagePicture {
  bytes: Uint8Array
  type: 'jpeg' | 'png'
  /** Words read off the picture, put back as invisible text. */
  words?: ReadText[]
}

/**
 * A new PDF where the given pages (0-based) are replaced by their pictures, at the size they're
 * shown, and every other page is copied as it is. Nothing of a replaced page survives: it is
 * never copied into the new file.
 */
export async function rebuildPages(
  bytes: Uint8Array,
  pictures: Map<number, PagePicture>,
): Promise<Uint8Array> {
  const src = await openPdf(bytes)
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)
  const count = src.getPageCount()
  const keep = Array.from({ length: count }, (_, i) => i).filter((i) => !pictures.has(i))
  isolatePages(src, keep)
  const copied = new Map<number, PDFPage>()
  const pages = await out.copyPages(src, keep)
  for (const [i, index] of keep.entries()) copied.set(index, pages[i] as PDFPage)
  for (let i = 0; i < count; i++) {
    const picture = pictures.get(i)
    if (!picture) {
      out.addPage(copied.get(i) as PDFPage)
      continue
    }
    const shown = shownSize(pageBox(src.getPage(i)))
    const image =
      picture.type === 'png' ? await out.embedPng(picture.bytes) : await out.embedJpg(picture.bytes)
    const page = out.addPage([shown.width, shown.height])
    page.drawImage(image, { x: 0, y: 0, width: shown.width, height: shown.height })
    if (picture.words?.length) drawInvisible(page, font, picture.words)
  }
  prune(
    out.context,
    out.getPages().map((p) => p.ref),
  )
  return out.save({ useObjectStreams: true })
}

// ---------------------------------------------------------------------------------------------
// Shrink (R4).

export type ShrinkLevel = 'email' | 'balanced' | 'keep'

/** Longest side in pixels and JPEG quality per level; Keep quality leaves pictures alone. */
export const SHRINK_LEVELS: Record<ShrinkLevel, { maxSide: number; quality: number } | null> = {
  email: { maxSide: 1400, quality: 0.6 },
  balanced: { maxSide: 2400, quality: 0.78 },
  keep: null,
}

/** A picture in the PDF, handed to the browser to make smaller. */
export interface PictureIn {
  /** The stored bytes: a JPEG, or raw 8-bit samples (rows of RGB or grey, no padding). */
  bytes: Uint8Array
  kind: 'jpeg' | 'raw'
  width: number
  height: number
  /** 3 for RGB, 1 for grey. */
  components: 1 | 3
}

/** A smaller JPEG, or null to keep the picture as it is. */
export type Recompress = (
  picture: PictureIn,
  target: { maxSide: number; quality: number },
) => Promise<{ bytes: Uint8Array; width: number; height: number; components: 1 | 3 } | null>

export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array>

export interface ShrinkResult {
  bytes: Uint8Array
  /** False when the result wasn't smaller, so the original stands. */
  smaller: boolean
  pictures: number
}

function nameOf(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(PDFName.of(key))
  return v instanceof PDFName ? v.decodeText() : null
}

function numberOf(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(PDFName.of(key))
  return v instanceof PDFNumber ? v.asNumber() : null
}

/**
 * Re-saves a PDF smaller: pictures stored as RGB or grey JPEGs, or as plain compressed samples,
 * are scaled down and saved again as JPEG (Balanced and For email), and the file is written with
 * compact object streams. Each picture keeps its place in the file, so nothing is left behind.
 */
export async function shrink(
  bytes: Uint8Array,
  level: ShrinkLevel,
  deps: { recompress: Recompress; inflate: Inflate },
): Promise<ShrinkResult> {
  const doc = await openPdf(bytes)
  const target = SHRINK_LEVELS[level]
  let pictures = 0
  if (target) {
    // Pictures used as another picture's mask must stay exact.
    const masks = new Set<string>()
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue
      for (const key of ['SMask', 'Mask']) {
        const ref = obj.dict.get(PDFName.of(key))
        if (ref && !(ref instanceof PDFDict)) masks.add(String(ref))
      }
    }
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || masks.has(String(ref))) continue
      const dict = obj.dict
      if (nameOf(dict, 'Subtype') !== 'Image') continue
      if (numberOf(dict, 'BitsPerComponent') !== 8) continue
      if (dict.get(PDFName.of('Decode')) || dict.get(PDFName.of('ImageMask'))) continue
      // A colour-key mask needs exact colours; a soft mask with Matte needs the same size.
      if (dict.lookup(PDFName.of('Mask')) instanceof PDFArray) continue
      const soft = dict.lookup(PDFName.of('SMask'))
      if (soft instanceof PDFStream && soft.dict.get(PDFName.of('Matte'))) continue
      const space = nameOf(dict, 'ColorSpace')
      const components = space === 'DeviceRGB' ? 3 : space === 'DeviceGray' ? 1 : null
      if (!components) continue
      const filter = nameOf(dict, 'Filter')
      const width = numberOf(dict, 'Width') ?? 0
      const height = numberOf(dict, 'Height') ?? 0
      if (width < 2 || height < 2) continue
      let picture: PictureIn
      if (filter === 'DCTDecode') {
        picture = { bytes: obj.contents, kind: 'jpeg', width, height, components }
      } else if (filter === 'FlateDecode' && !dict.get(PDFName.of('DecodeParms'))) {
        let raw: Uint8Array
        try {
          raw = await deps.inflate(obj.contents)
        } catch {
          continue
        }
        if (raw.length !== width * height * components) continue
        picture = { bytes: raw, kind: 'raw', width, height, components }
      } else continue
      const smaller = await deps.recompress(picture, target).catch(() => null)
      if (!smaller || smaller.bytes.length >= obj.contents.length) continue
      const replaced = PDFRawStream.of(dict.clone(doc.context), smaller.bytes)
      replaced.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
      replaced.dict.delete(PDFName.of('DecodeParms'))
      replaced.dict.set(PDFName.of('Width'), PDFNumber.of(smaller.width))
      replaced.dict.set(PDFName.of('Height'), PDFNumber.of(smaller.height))
      replaced.dict.set(
        PDFName.of('ColorSpace'),
        PDFName.of(smaller.components === 3 ? 'DeviceRGB' : 'DeviceGray'),
      )
      replaced.dict.set(PDFName.of('Length'), PDFNumber.of(smaller.bytes.length))
      doc.context.assign(ref, replaced)
      pictures++
    }
  }
  const out = await doc.save({ useObjectStreams: true })
  return out.length < bytes.length
    ? { bytes: out, smaller: true, pictures }
    : { bytes, smaller: false, pictures }
}
