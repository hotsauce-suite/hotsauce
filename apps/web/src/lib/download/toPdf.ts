// A Doc as a PDF (docs/PLAN-doc-download.md R3, R5), with the MIT `pdfmake` library. The layout is
// a plain pdfmake definition, built by `pdfDefinition` so tests can read it without drawing.

import {
  CODE_BG,
  type DownloadInputs,
  type FontFiles,
  fit,
  INK,
  INK_SOFT,
  RULE,
  wash,
} from './inputs'
import type { Align, Block, DocModel, Inline } from './model'

// pdfmake's document definition, as loosely as pdfmake itself reads it.
type Content = string | Content[] | { [key: string]: unknown }
interface ContentText {
  text: string | (string | ContentText)[]
  [key: string]: unknown
}
interface TDocumentDefinitions {
  content: Content[]
  defaultStyle: Record<string, unknown>
  footer: (page: number) => Content
  pageBreakBefore: (node: unknown) => boolean
  [key: string]: unknown
}

/** Letter with one-inch margins: 468 points of text. Pixels become points at 96 to the inch. */
const TEXT_WIDTH_PT = 468
const PX = 0.75

/** A slide: 16:9, as wide as a Letter page is tall, with half-inch margins. */
const SLIDE_PAGE = { width: 792, height: 445.5 }
const SLIDE_MARGIN_PT = 44
const SLIDE_IMAGE_HEIGHT_PT = 230

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 17, 3: 14, 4: 12, 5: 11, 6: 11 }

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

const dataUrl = (image: { bytes: Uint8Array; type: 'png' | 'jpg' }) =>
  `data:image/${image.type === 'jpg' ? 'jpeg' : 'png'};base64,${base64(image.bytes)}`

/** A checkbox drawn as lines: neither the standard fonts nor most brand fonts have ☐ and ☑. */
function checkbox(checked: boolean, color: string): Content {
  const box = `<rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="${INK_SOFT}"/>`
  const tick = checked
    ? `<path d="M2.3 5.2 L4.3 7.2 L7.8 2.8" fill="none" stroke="${color}" stroke-width="1.6"/>`
    : ''
  return {
    svg: `<svg width="10" height="10" viewBox="0 0 10 10">${box}${tick}</svg>`,
    width: 10,
    margin: [0, 2, 0, 0],
  }
}

interface Ctx {
  inputs: DownloadInputs
  /** The text column's width in points. */
  width: number
  /** Type sizes against a document's (slides are set larger). */
  scale: number
  /** Slides (docs/PLAN-slides.md R10): a rule between blocks starts the next page. */
  slides: boolean
  /** Monospace face: the standard Courier, always there. */
  mono: string
  /** The headings' face. */
  display: string
}

type Piece = string | ContentText

function texts(list: Inline[], ctx: Ctx): { pieces: Piece[]; images: Content[] } {
  const pieces: Piece[] = []
  const images: Content[] = []
  for (const r of list) {
    if (r.t === 'break') pieces.push('\n')
    else if (r.t === 'image') {
      const image = ctx.inputs.images.get(r.src)
      if (image) {
        const size = fit(
          { width: image.width * PX, height: image.height * PX },
          ctx.width,
          ...(ctx.slides ? [SLIDE_IMAGE_HEIGHT_PT] : []),
        )
        images.push({ image: dataUrl(image), ...size, margin: [0, 4, 0, 8] })
      } else pieces.push({ text: `[${r.alt || 'Image'}]`, italics: true, color: INK_SOFT })
    } else {
      const piece: ContentText = { text: r.text }
      if (r.bold) piece.bold = true
      if (r.italic) piece.italics = true
      if (r.strike) piece.decoration = 'lineThrough'
      if (r.code)
        Object.assign(piece, { font: ctx.mono, background: CODE_BG, fontSize: 9.5 * ctx.scale })
      if (r.href)
        Object.assign(piece, {
          link: r.href,
          color: ctx.inputs.brand.primary,
          decoration: 'underline',
        })
      pieces.push(piece)
    }
  }
  return { pieces, images }
}

/** A paragraph's words, then its images on their own lines (a photo in a sentence reads oddly). */
function paragraph(list: Inline[], ctx: Ctx, style: Partial<ContentText> = {}): Content[] {
  const { pieces, images } = texts(list, ctx)
  const out: Content[] = []
  if (pieces.some((p) => (typeof p === 'string' ? p.trim() : String(p.text).trim()))) {
    out.push({ text: pieces, margin: [0, 0, 0, 6], ...style })
  }
  out.push(...images)
  return out
}

function table(rows: Inline[][][], align: Align[], ctx: Ctx): Content {
  const width = Math.max(1, ...rows.map((r) => r.length))
  return {
    margin: [0, 2, 0, 10],
    layout: {
      hLineColor: () => RULE,
      vLineColor: () => RULE,
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      fillColor: (row: number) => (row === 0 ? wash(ctx.inputs.brand.primary) : null),
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    table: {
      headerRows: 1,
      widths: Array.from({ length: width }, () => '*'),
      body: rows.map((row, i) =>
        Array.from({ length: width }, (_, c) => ({
          stack: paragraph(row[c] ?? [], ctx, { margin: [0, 0, 0, 0] }),
          ...(i === 0 ? { bold: true } : {}),
          ...(align[c] ? { alignment: align[c] } : {}),
        })),
      ),
    },
  } as Content
}

function checkRow(checked: boolean, body: Content[], ctx: Ctx): Content {
  return {
    columns: [checkbox(checked, ctx.inputs.brand.primary), { stack: body, width: '*' }],
    columnGap: 6,
    margin: [0, 0, 0, 2],
  }
}

/** `tight`: inside a list item, where paragraphs sit closer together. */
function bulletRow(marker: string, body: Content[]): Content {
  return {
    columns: [
      { text: marker, width: 10, color: INK_SOFT },
      { stack: body, width: '*' },
    ],
    columnGap: 6,
    margin: [0, 0, 0, 2],
  }
}

function blocks(list: Block[], ctx: Ctx, tight = false): Content[] {
  const out: Content[] = []
  for (const b of list) {
    switch (b.t) {
      case 'heading': {
        const heading = texts(b.inlines, ctx)
        out.push({
          text: heading.pieces,
          font: ctx.display,
          bold: true,
          fontSize: (HEADING_SIZE[b.level] ?? 11) * ctx.scale,
          color: b.level >= 5 ? INK_SOFT : INK,
          // A deck's title slide sits a third of the way down its page.
          margin: [0, b.level === 1 ? (ctx.slides ? 110 : 4) : 10, 0, 6],
          headlineLevel: b.level,
        } as Content)
        out.push(...heading.images)
        break
      }
      case 'para':
        out.push(...paragraph(b.inlines, ctx, tight ? { margin: [0, 0, 0, 2] } : {}))
        break
      case 'quote':
        out.push({
          margin: [0, 2, 0, 8],
          table: {
            widths: [2, '*'],
            body: [
              [
                { text: '', fillColor: ctx.inputs.brand.primary },
                { stack: blocks(b.blocks, ctx), color: INK_SOFT, margin: [8, 0, 0, 0] },
              ],
            ],
          },
          layout: 'noBorders',
        } as Content)
        break
      case 'code':
        out.push({
          margin: [0, 2, 0, 10],
          table: {
            widths: ['*'],
            body: [
              [
                {
                  text: b.text,
                  font: ctx.mono,
                  fontSize: 9 * ctx.scale,
                  preserveLeadingSpaces: true,
                  fillColor: CODE_BG,
                  margin: [6, 4, 6, 4],
                },
              ],
            ],
          },
          layout: 'noBorders',
        } as Content)
        break
      case 'rule':
        // In a deck, the line between two slides: the next one starts its own page.
        if (ctx.slides) {
          out.push({ text: '', pageBreak: 'after' })
          break
        }
        out.push({
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: ctx.width,
              y2: 0,
              lineWidth: 0.7,
              lineColor: RULE,
            },
          ],
          margin: [0, 6, 0, 10],
        })
        break
      case 'table':
        out.push(table(b.rows, b.align, ctx))
        break
      case 'tasks': {
        const lines = ctx.inputs.tasks.get(b.source) ?? []
        if (lines.length === 0) out.push({ text: 'No tasks', italics: true, color: INK_SOFT })
        for (const line of lines) {
          out.push(
            checkRow(
              line.done,
              [
                {
                  text: line.title,
                  ...(line.done ? { decoration: 'lineThrough' } : {}),
                } as Content,
              ],
              ctx,
            ),
          )
        }
        out.push({ text: '', margin: [0, 0, 0, 6] })
        break
      }
      case 'list': {
        // A list with any task item is drawn row by row; its plain items keep a marker.
        const tasky = b.items.some((i) => i.checked !== null)
        const items = b.items.map((item, index) => {
          const body = blocks(item.blocks, ctx, true)
          if (item.checked !== null) return checkRow(item.checked, body, ctx)
          return tasky ? bulletRow(b.ordered ? `${b.start + index}.` : '•', body) : { stack: body }
        })
        out.push(
          tasky
            ? { stack: items, margin: [0, 0, 0, 6] }
            : b.ordered
              ? { ol: items, start: b.start, margin: [0, 0, 0, 6], markerColor: INK_SOFT }
              : { ul: items, margin: [0, 0, 0, 6], markerColor: INK_SOFT },
        )
        break
      }
    }
  }
  return out
}

/** The fonts a definition names: the brand's when their files came, standard ones otherwise. */
export interface PdfFonts {
  ui: string
  display: string
}

export function pdfDefinition(
  model: DocModel,
  inputs: DownloadInputs,
  fonts: PdfFonts = { ui: 'ui', display: 'display' },
  layout: PdfLayout = 'doc',
): TDocumentDefinitions {
  if (layout === 'slides') return slidesDefinition(model, inputs, fonts)
  const ctx: Ctx = {
    inputs,
    mono: 'Courier',
    display: fonts.display,
    width: TEXT_WIDTH_PT,
    scale: 1,
    slides: false,
  }
  const content = blocks(model.blocks, ctx)
  const logo = inputs.brand.logo
  const top: Content[] = logo
    ? [
        {
          image: dataUrl(logo),
          ...fit({ width: logo.width * PX, height: logo.height * PX }, 120, 36),
          margin: [0, 0, 0, 18],
        },
      ]
    : []
  return {
    pageSize: 'LETTER',
    pageMargins: [72, 72, 72, 72],
    info: { title: model.title, author: inputs.brand.orgName, creator: inputs.brand.orgName },
    content: [...top, ...content],
    defaultStyle: { font: fonts.ui, fontSize: 10.5, lineHeight: 1.3, color: INK },
    footer: (page: number) => ({
      text: String(page),
      alignment: 'center',
      fontSize: 8.5,
      color: INK_SOFT,
      margin: [0, 30, 0, 0],
    }),
    pageBreakBefore: (node) => {
      // Keep a heading with what follows it: never the last line of a page.
      const n = node as { headlineLevel?: number; startPosition?: { verticalRatio: number } }
      return Boolean(n.headlineLevel && (n.startPosition?.verticalRatio ?? 0) > 0.9)
    },
  }
}

/**
 * A deck (docs/PLAN-slides.md R10): one 16:9 page per slide, the slides split by rules (the deck's
 * own `---`), type set for a screen, the slide number in the corner, the logo on the first.
 */
function slidesDefinition(
  model: DocModel,
  inputs: DownloadInputs,
  fonts: PdfFonts,
): TDocumentDefinitions {
  const ctx: Ctx = {
    inputs,
    mono: 'Courier',
    display: fonts.display,
    width: SLIDE_PAGE.width - 2 * SLIDE_MARGIN_PT,
    scale: 1.75,
    slides: true,
  }
  const logo = inputs.brand.logo
  return {
    pageSize: SLIDE_PAGE,
    pageOrientation: 'landscape',
    pageMargins: [SLIDE_MARGIN_PT, SLIDE_MARGIN_PT, SLIDE_MARGIN_PT, SLIDE_MARGIN_PT],
    info: { title: model.title, author: inputs.brand.orgName, creator: inputs.brand.orgName },
    content: blocks(model.blocks, ctx),
    defaultStyle: { font: fonts.ui, fontSize: 18, lineHeight: 1.3, color: INK },
    background: (page: number) => [
      {
        canvas: [
          { type: 'rect', x: 0, y: 0, w: SLIDE_PAGE.width, h: SLIDE_PAGE.height, color: '#fbf8f3' },
        ],
      },
      ...(page === 1 && logo
        ? [
            {
              image: dataUrl(logo),
              ...fit({ width: logo.width * PX, height: logo.height * PX }, 110, 30),
              absolutePosition: { x: SLIDE_MARGIN_PT, y: SLIDE_PAGE.height - SLIDE_MARGIN_PT - 30 },
            },
          ]
        : []),
    ],
    footer: (page: number) => ({
      text: String(page),
      alignment: 'right',
      fontSize: 10,
      color: INK_SOFT,
      margin: [0, 14, 24, 0],
    }),
    pageBreakBefore: () => false,
  }
}

function vfsEntry(files: FontFiles, family: string): Record<string, string> | null {
  if (!files.regular) return null
  const r = files.regular
  return {
    [`${family}-r.ttf`]: base64(r),
    [`${family}-b.ttf`]: base64(files.bold ?? r),
    [`${family}-i.ttf`]: base64(files.italic ?? r),
    [`${family}-bi.ttf`]: base64(files.boldItalic ?? files.bold ?? r),
  }
}

const faces = (family: string) => ({
  normal: `${family}-r.ttf`,
  bold: `${family}-b.ttf`,
  italics: `${family}-i.ttf`,
  bolditalics: `${family}-bi.ttf`,
})

/** A document on Letter pages, or a deck on 16:9 ones. */
export type PdfLayout = 'doc' | 'slides'

export async function toPdf(
  model: DocModel,
  inputs: DownloadInputs,
  layout: PdfLayout = 'doc',
): Promise<Blob> {
  const [{ default: pdfMake }, helvetica, times, courier] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/standard-fonts/Helvetica'),
    import('pdfmake/build/standard-fonts/Times'),
    import('pdfmake/build/standard-fonts/Courier'),
  ])
  for (const container of [helvetica, times, courier]) {
    pdfMake.addFontContainer((container as { default?: unknown }).default ?? container)
  }
  // Everything is inlined as data: URLs; the PDF never fetches anything.
  pdfMake.setUrlAccessPolicy(() => false)
  const fonts: PdfFonts = { ui: 'Helvetica', display: 'Times' }
  const ui = vfsEntry(inputs.fonts.ui, 'ui')
  if (ui) {
    pdfMake.addVirtualFileSystem(ui)
    pdfMake.addFonts({ ui: faces('ui') })
    fonts.ui = 'ui'
  }
  const display = vfsEntry(inputs.fonts.display, 'display')
  if (display) {
    pdfMake.addVirtualFileSystem(display)
    pdfMake.addFonts({ display: faces('display') })
    fonts.display = 'display'
  } else if (ui && inputs.brand.displayFont === inputs.brand.uiFont) fonts.display = 'ui'
  return pdfMake.createPdf(pdfDefinition(model, inputs, fonts, layout)).getBlob()
}
