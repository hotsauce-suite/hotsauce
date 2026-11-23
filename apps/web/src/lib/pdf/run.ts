// The browser half of PDF tools (docs/PLAN-pdf-tools.md): ties pdf.js drawing, text reading and
// picture re-encoding to the pure functions in tools.ts.

import { type TextReader, textReader } from './ocr'
import { canvasBytes, drawPage, openView, pageHasText, type ShownBox } from './render'
import {
  addTextLayer,
  type Inflate,
  type PagePicture,
  type ReadText,
  type Recompress,
  rebuildPages,
  type ShrinkLevel,
  type ShrinkResult,
  shrink,
} from './tools'

/** Long side of a page picture read for text: about 250 dpi on A4. */
const READ_SIDE = 2900
/** Long side of a redacted page's picture: about 200 dpi on A4. */
const REDACT_SIDE = 2300

export type Progress = (done: number, total: number) => void

export interface SearchableResult {
  bytes: Uint8Array
  /** Pages read for text. */
  read: number
  /** Pages that had text of their own. */
  skipped: number
  reader: TextReader['name']
}

/** Make searchable (R5, R6): reads every page with no text of its own and adds its words. */
export async function makeSearchable(
  bytes: Uint8Array,
  onProgress: Progress,
  pickReader: () => Promise<TextReader> = textReader,
): Promise<SearchableResult> {
  const view = await openView(bytes)
  let reader: TextReader | null = null
  try {
    const total = view.numPages
    const todo: number[] = []
    for (let n = 1; n <= total; n++) if (!(await pageHasText(view, n))) todo.push(n)
    const found = new Map<number, ReadText[]>()
    onProgress(0, todo.length)
    if (todo.length > 0) {
      reader = await pickReader()
      for (const [i, n] of todo.entries()) {
        const canvas = await drawPage(view, n, READ_SIDE)
        found.set(n - 1, await reader.read(canvas))
        canvas.width = 0
        onProgress(i + 1, todo.length)
      }
    }
    return {
      bytes: todo.length ? await addTextLayer(bytes, found) : bytes,
      read: todo.length,
      skipped: total - todo.length,
      reader: reader?.name ?? 'web',
    }
  } finally {
    await reader?.close().catch(() => {})
    await view.destroy()
  }
}

/**
 * Redact (R7): each page with a box is drawn, the boxes painted solid black, read again for its
 * other words, and put back as that picture; every other page is copied as it is.
 */
export async function redact(
  bytes: Uint8Array,
  boxes: Map<number, ShownBox[]>,
  onProgress: Progress,
  pickReader: () => Promise<TextReader> = textReader,
): Promise<Uint8Array> {
  const view = await openView(bytes)
  let reader: TextReader | null = null
  try {
    reader = await pickReader().catch(() => null)
    const pictures = new Map<number, PagePicture>()
    const pages = [...boxes.entries()].filter(([, b]) => b.length > 0)
    onProgress(0, pages.length)
    for (const [i, [index, list]] of pages.entries()) {
      const canvas = await drawPage(view, index + 1, REDACT_SIDE)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('This browser can’t draw PDF pages.')
      ctx.fillStyle = '#000000'
      for (const b of list) {
        ctx.fillRect(
          Math.floor(b.x * canvas.width),
          Math.floor(b.y * canvas.height),
          Math.ceil(b.width * canvas.width) + 1,
          Math.ceil(b.height * canvas.height) + 1,
        )
      }
      const words = reader ? await reader.read(canvas).catch(() => []) : []
      pictures.set(index, {
        bytes: await canvasBytes(canvas, 'image/jpeg', 0.85),
        type: 'jpeg',
        words,
      })
      canvas.width = 0
      onProgress(i + 1, pages.length)
    }
    return await rebuildPages(bytes, pictures)
  } finally {
    await reader?.close().catch(() => {})
    await view.destroy()
  }
}

const inflate: Inflate = async (data) => {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const recompress: Recompress = async (picture, target) => {
  const scale = Math.min(1, target.maxSide / Math.max(picture.width, picture.height))
  const width = Math.max(1, Math.round(picture.width * scale))
  const height = Math.max(1, Math.round(picture.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  if (picture.kind === 'jpeg') {
    const bitmap = await createImageBitmap(
      new Blob([picture.bytes as BlobPart], { type: 'image/jpeg' }),
      // PDF readers ignore a photo's own turn; so must this.
      { imageOrientation: 'none' },
    )
    if (bitmap.width !== picture.width || bitmap.height !== picture.height) {
      bitmap.close()
      return null
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
  } else {
    const full = document.createElement('canvas')
    full.width = picture.width
    full.height = picture.height
    const fctx = full.getContext('2d')
    if (!fctx) return null
    const rgba = new ImageData(picture.width, picture.height)
    const src = picture.bytes
    for (let p = 0, s = 0; p < rgba.data.length; p += 4) {
      if (picture.components === 3) {
        rgba.data[p] = src[s++] ?? 0
        rgba.data[p + 1] = src[s++] ?? 0
        rgba.data[p + 2] = src[s++] ?? 0
      } else {
        const g = src[s++] ?? 0
        rgba.data[p] = g
        rgba.data[p + 1] = g
        rgba.data[p + 2] = g
      }
      rgba.data[p + 3] = 255
    }
    fctx.putImageData(rgba, 0, 0)
    ctx.drawImage(full, 0, 0, width, height)
    full.width = 0
  }
  const out = await canvasBytes(canvas, 'image/jpeg', target.quality)
  canvas.width = 0
  return { bytes: out, width, height, components: 3 }
}

/** Shrink (R4) with the browser's picture tools. */
export function shrinkPdf(bytes: Uint8Array, level: ShrinkLevel): Promise<ShrinkResult> {
  return shrink(bytes, level, { recompress, inflate })
}
