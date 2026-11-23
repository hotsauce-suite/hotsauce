// A Doc as a PDF (docs/PLAN-doc-download.md R3, R5), with the MIT `pdfmake` library. The layout is
// a plain pdfmake definition, built by `pdfDefinition` so tests can read it without drawing.

import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces'
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

/** Letter with one-inch margins: 468 points of text. Pixels become points at 96 to the inch. */
const TEXT_WIDTH_PT = 468
const PX = 0.75

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
        const size = fit({ width: image.width * PX, height: image.height * PX }, TEXT_WIDTH_PT)
        images.push({ image: dataUrl(image), ...size, margin: [0, 4, 0, 8] })
      } else pieces.push({ text: `[${r.alt || 'Image'}]`, italics: true, color: INK_SOFT })
    } else {
      const piece: ContentText = { text: r.text }
      if (r.bold) piece.bold = true
      if (r.italic) piece.italics = true
      if (r.strike) piece.decoration = 'lineThrough'
      if (r.code) Object.assign(piece, { font: ctx.mono, background: CODE_BG, fontSize: 9.5 })
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
          text: texts(row[c] ?? [], ctx).pieces,
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
function blocks(list: Block[], ctx: Ctx, tight = false): Content[] {
  const out: Content[] = []
  for (const b of list) {
    switch (b.t) {
      case 'heading':
        out.push({
          text: texts(b.inlines, ctx).pieces,
          font: ctx.display,
          bold: true,
          fontSize: HEADING_SIZE[b.level] ?? 11,
          color: b.level >= 5 ? INK_SOFT : INK,
          margin: [0, b.level === 1 ? 4 : 10, 0, 6],
          headlineLevel: b.level,
        } as Content)
        break
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
                  fontSize: 9,
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
        out.push({
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: TEXT_WIDTH_PT,
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
        const items = b.items.map((item) => {
          const body = blocks(item.blocks, ctx, true)
          return item.checked === null ? { stack: body } : checkRow(item.checked, body, ctx)
        })
        const tasky = b.items.some((i) => i.checked !== null)
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
): TDocumentDefinitions {
  const ctx: Ctx = { inputs, mono: 'Courier', display: fonts.display }
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

export async function toPdf(model: DocModel, inputs: DownloadInputs): Promise<Blob> {
  const [{ default: pdfMake }, helvetica, times, courier] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/standard-fonts/Helvetica'),
    import('pdfmake/build/standard-fonts/Times'),
    import('pdfmake/build/standard-fonts/Courier'),
  ])
  for (const container of [helvetica, times, courier]) {
    const found = (container as { default?: unknown }).default ?? container
    pdfMake.addFontContainer(found as Parameters<typeof pdfMake.addFontContainer>[0])
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
  return pdfMake.createPdf(pdfDefinition(model, inputs, fonts)).getBlob()
}
