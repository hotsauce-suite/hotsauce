// A Doc as a Word file (docs/PLAN-doc-download.md R2, R5, R6), with the MIT `docx` library.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { CODE_BG, type DownloadInputs, fit, INK, INK_SOFT, RULE, wash } from './inputs'
import type { Align, Block, DocModel, Inline } from './model'

const MONO = 'Courier New'
/** Letter, one-inch margins: 6.5 inches of text, at 96 pixels to the inch. */
const TEXT_WIDTH_PX = 624
/** Twips per indent step for nested lists and quotes. */
const STEP = 360

const hex = (color: string) => color.replace('#', '').toUpperCase()

const HEADING: Record<1 | 2 | 3 | 4 | 5 | 6, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
}

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
}

interface Ctx {
  inputs: DownloadInputs
  /** Each ordered list restarts its numbers: one Word numbering instance per list. */
  nextList: () => number
  /** Numbered lists that don't start at 1 each name a numbering with their start. */
  starts: Set<number>
}

function runs(list: Inline[], ctx: Ctx, extra: { bold?: boolean } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const r of list) {
    if (r.t === 'break') {
      out.push(new TextRun({ text: '', break: 1 }))
      continue
    }
    if (r.t === 'image') {
      const image = ctx.inputs.images.get(r.src)
      if (image) {
        out.push(
          new ImageRun({
            type: image.type,
            data: image.bytes,
            transformation: fit(image, TEXT_WIDTH_PX),
            altText: { name: r.alt || 'Image', description: r.alt, title: r.alt },
          }),
        )
      } else {
        out.push(
          new TextRun({ text: `[${r.alt || 'Image'}]`, italics: true, color: hex(INK_SOFT) }),
        )
      }
      continue
    }
    const run = new TextRun({
      text: r.text,
      // Only marks that are on: an explicit "off" would undo a heading's bold.
      ...(r.bold || extra.bold ? { bold: true } : {}),
      ...(r.italic ? { italics: true } : {}),
      ...(r.strike ? { strike: true } : {}),
      ...(r.code ? { font: MONO, shading: { type: ShadingType.CLEAR, fill: hex(CODE_BG) } } : {}),
      ...(r.href ? { color: hex(ctx.inputs.brand.primary), underline: {} } : {}),
    })
    out.push(r.href ? new ExternalHyperlink({ link: r.href, children: [run] }) : run)
  }
  return out
}

type Out = Paragraph | Table

function table(rows: Inline[][][], align: Align[], ctx: Ctx): Table {
  const width = Math.max(1, ...rows.map((r) => r.length))
  const border = { style: BorderStyle.SINGLE, size: 4, color: hex(RULE) }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: rows.map(
      (row, i) =>
        new TableRow({
          tableHeader: i === 0,
          children: Array.from({ length: width }, (_, c) => {
            const a = align[c]
            return new TableCell({
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              ...(i === 0
                ? {
                    shading: { type: ShadingType.CLEAR, fill: hex(wash(ctx.inputs.brand.primary)) },
                  }
                : {}),
              children: [
                new Paragraph({
                  ...(a && ALIGN[a] ? { alignment: ALIGN[a] } : {}),
                  children: runs(row[c] ?? [], ctx, i === 0 ? { bold: true } : {}),
                }),
              ],
            })
          }),
        }),
    ),
  })
}

function blocks(list: Block[], ctx: Ctx, depth: number, quote: boolean): Out[] {
  const out: Out[] = []
  const quoteProps = quote
    ? {
        indent: { left: STEP * (depth + 1) },
        border: {
          left: {
            style: BorderStyle.SINGLE,
            size: 18,
            color: hex(ctx.inputs.brand.primary),
            space: 8,
          },
        },
      }
    : depth > 0
      ? { indent: { left: STEP * depth } }
      : {}
  for (const b of list) {
    switch (b.t) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADING[b.level], children: runs(b.inlines, ctx) }))
        break
      case 'para':
        out.push(new Paragraph({ ...quoteProps, children: runs(b.inlines, ctx) }))
        break
      case 'quote':
        out.push(...blocks(b.blocks, ctx, quote ? depth + 1 : depth, true))
        break
      case 'code':
        for (const line of b.text.split('\n')) {
          out.push(
            new Paragraph({
              ...(depth > 0 ? { indent: { left: STEP * depth } } : {}),
              spacing: { after: 0, line: 260 },
              shading: { type: ShadingType.CLEAR, fill: hex(CODE_BG) },
              children: [new TextRun({ text: line || ' ', font: MONO, size: 19 })],
            }),
          )
        }
        out.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
        break
      case 'rule':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: hex(RULE), space: 1 } },
            children: [],
          }),
        )
        break
      case 'table':
        out.push(table(b.rows, b.align, ctx))
        out.push(new Paragraph({ children: [] }))
        break
      case 'tasks': {
        const lines = ctx.inputs.tasks.get(b.source) ?? []
        if (lines.length === 0) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: 'No tasks', italics: true, color: hex(INK_SOFT) })],
            }),
          )
        }
        for (const line of lines) {
          out.push(
            new Paragraph({
              indent: { left: STEP * (depth + 1), hanging: STEP },
              children: [
                new TextRun({ text: `${line.done ? '☑' : '☐'}\t` }),
                new TextRun({ text: line.title, strike: line.done }),
              ],
            }),
          )
        }
        break
      }
      case 'list': {
        const instance = ctx.nextList()
        for (const item of b.items) {
          const [first, ...rest] = item.blocks
          const firstRuns = first && first.t === 'para' ? runs(first.inlines, ctx) : []
          if (item.checked !== null) {
            out.push(
              new Paragraph({
                indent: { left: STEP * (depth + 1), hanging: STEP },
                children: [new TextRun({ text: `${item.checked ? '☑' : '☐'}\t` }), ...firstRuns],
              }),
            )
          } else {
            out.push(
              new Paragraph({
                numbering: {
                  reference: b.ordered ? orderedRef(b.start, ctx) : 'bullets',
                  level: Math.min(depth, 8),
                  ...(b.ordered ? { instance } : {}),
                },
                children: firstRuns,
              }),
            )
          }
          const remaining = first && first.t === 'para' ? rest : item.blocks
          out.push(...blocks(remaining, ctx, depth + 1, false))
        }
        break
      }
    }
  }
  return out
}

const BULLETS = ['•', '◦', '▪']

function orderedRef(start: number, ctx: Ctx): string {
  if (start === 1) return 'ordered'
  ctx.starts.add(start)
  return `ordered-${start}`
}

function levels(ordered: boolean, start = 1) {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    ...(ordered && level === 0 ? { start } : {}),
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : (BULLETS[level % 3] ?? '•'),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: STEP * (level + 1), hanging: STEP } } },
  }))
}

function fontEmbeds(inputs: DownloadInputs) {
  const { brand, fonts } = inputs
  const families: [string, typeof fonts.ui][] = [[brand.uiFont, fonts.ui]]
  if (brand.displayFont !== brand.uiFont) families.push([brand.displayFont, fonts.display])
  return families.flatMap(([name, files]) =>
    files.regular
      ? [
          {
            name,
            data: files.regular as Buffer,
            ...(files.bold ? { bold: files.bold as Buffer } : {}),
            ...(files.italic ? { italic: files.italic as Buffer } : {}),
            ...(files.boldItalic ? { boldItalic: files.boldItalic as Buffer } : {}),
          },
        ]
      : [],
  )
}

/** The Word document itself, before packing (tests read its parts). */
export function docxDocument(model: DocModel, inputs: DownloadInputs): Document {
  const { brand } = inputs
  let lists = 0
  const ctx: Ctx = { inputs, nextList: () => ++lists, starts: new Set() }
  const body = blocks(model.blocks, ctx, 0, false)
  const heading = (size: number, color = INK) => ({
    run: { font: brand.displayFont, size, bold: true, color: hex(color) },
    paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
  })
  const logo = brand.logo
  const top: Paragraph[] = logo
    ? [
        new Paragraph({
          spacing: { after: 240 },
          children: [
            new ImageRun({
              type: logo.type,
              data: logo.bytes,
              transformation: fit(logo, 160, 48),
              altText: { name: brand.orgName, description: brand.orgName, title: brand.orgName },
            }),
          ],
        }),
      ]
    : []
  return new Document({
    title: model.title,
    creator: brand.orgName,
    fonts: fontEmbeds(inputs),
    styles: {
      default: {
        document: { run: { font: brand.uiFont, size: 22, color: hex(INK) } },
        heading1: heading(36),
        heading2: heading(28),
        heading3: heading(24),
        heading4: heading(22),
        heading5: heading(22, INK_SOFT),
        heading6: heading(22, INK_SOFT),
        hyperlink: { run: { color: hex(brand.primary), underline: {} } },
      },
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: { font: brand.uiFont, size: 22 },
          paragraph: { spacing: { after: 120, line: 300 } },
        },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(false) },
        { reference: 'ordered', levels: levels(true) },
        ...[...ctx.starts].map((start) => ({
          reference: `ordered-${start}`,
          levels: levels(true, start),
        })),
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: hex(INK_SOFT) }),
                ],
              }),
            ],
          }),
        },
        children: [...top, ...body],
      },
    ],
  })
}

export function toDocx(model: DocModel, inputs: DownloadInputs): Promise<Blob> {
  return Packer.toBlob(docxDocument(model, inputs))
}
