// Drawing and reading PDF pages in the browser with pdf.js (Apache), for PDF tools
// (docs/PLAN-pdf-tools.md). Loaded only when the panel opens.

export type PdfView = import('pdfjs-dist').PDFDocumentProxy

export async function openView(bytes: Uint8Array): Promise<PdfView> {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ).default
  }
  // pdf.js hands the buffer to its worker, so it gets a copy and the caller keeps the bytes.
  return pdfjs.getDocument({ data: bytes.slice() }).promise
}

/** Page `n` (1-based) drawn as it is shown, its longest side about `longSide` pixels. */
export async function drawPage(
  view: PdfView,
  n: number,
  longSide: number,
  extraRotation = 0,
): Promise<HTMLCanvasElement> {
  const page = await view.getPage(n)
  const rotation = (((page.rotate + extraRotation) % 360) + 360) % 360
  const base = page.getViewport({ scale: 1, rotation })
  const scale = longSide / Math.max(base.width, base.height)
  const viewport = page.getViewport({ scale, rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser can’t draw PDF pages.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return canvas
}

interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
}

const isTextItem = (i: unknown): i is TextItemLike =>
  typeof (i as TextItemLike).str === 'string' && Array.isArray((i as TextItemLike).transform)

/** Whether page `n` has text of its own (then Make searchable leaves it alone). */
export async function pageHasText(view: PdfView, n: number): Promise<boolean> {
  const page = await view.getPage(n)
  const content = await page.getTextContent()
  return content.items.some((i) => isTextItem(i) && i.str.trim().length > 0)
}

/** A box on a page as shown, as fractions from its top-left. */
export interface ShownBox {
  x: number
  y: number
  width: number
  height: number
}

let measurer: CanvasRenderingContext2D | null | undefined

/**
 * Where letters `from` to `to` of `text` sit, as shares of the whole run's width. Measured in the
 * run's own kind of font where the browser can; else by letter count.
 */
function share(text: string, from: number, to: number, family: string): [number, number] {
  if (measurer === undefined) {
    try {
      measurer = document.createElement('canvas').getContext('2d')
    } catch {
      measurer = null
    }
  }
  const ctx = measurer
  if (ctx) {
    ctx.font = `100px ${family || 'sans-serif'}`
    const whole = ctx.measureText(text).width
    if (whole > 0) {
      return [
        ctx.measureText(text.slice(0, from)).width / whole,
        ctx.measureText(text.slice(0, to)).width / whole,
      ]
    }
  }
  return [from / text.length, to / text.length]
}

/** Letters `from` to `to` of `text`, widened to whole words, so no part of a word shows. */
export function wholeWords(text: string, from: number, to: number): [number, number] {
  let a = from
  let b = to
  while (a > 0 && /\S/.test(text[a - 1] as string)) a--
  while (b < text.length && /\S/.test(text[b] as string)) b++
  return [a, b]
}

/**
 * Every place `query` appears on page `n`, as boxes on the page as shown (Redact, R7). Matching
 * ignores case and spaces, so a name split across runs or lines is still found; each run it
 * touches gets its own box, widened to whole words, and turned text gets a box that follows it.
 */
export async function findText(view: PdfView, n: number, query: string): Promise<ShownBox[]> {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return []
  const page = await view.getPage(n)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const styles = (content as { styles?: Record<string, { fontFamily?: string }> }).styles ?? {}
  const items = (content.items as unknown[]).filter(isTextItem)
  // The page's letters without spaces, and where each came from.
  let joined = ''
  const from: Array<[number, number]> = []
  for (const [i, item] of items.entries()) {
    const lower = item.str.toLowerCase()
    for (let c = 0; c < lower.length; c++) {
      if (/\s/.test(lower[c] as string)) continue
      joined += lower[c]
      from.push([i, c])
    }
  }
  const boxes: ShownBox[] = []
  for (let at = joined.indexOf(q); at >= 0; at = joined.indexOf(q, at + q.length)) {
    // Letters of the match, run by run.
    const runs = new Map<number, [number, number]>()
    for (let k = at; k < at + q.length; k++) {
      const [i, c] = from[k] as [number, number]
      const span = runs.get(i)
      runs.set(i, span ? [Math.min(span[0], c), Math.max(span[1], c + 1)] : [c, c + 1])
    }
    for (const [i, [c0, c1]] of runs) {
      const item = items[i] as TextItemLike
      const family = styles[(item as { fontName?: string }).fontName ?? '']?.fontFamily ?? ''
      boxes.push(runBox(viewport, item, wholeWords(item.str, c0, c1), family))
    }
  }
  return boxes
}

function runBox(
  viewport: ReturnType<Awaited<ReturnType<PdfView['getPage']>>['getViewport']>,
  item: TextItemLike,
  [c0, c1]: [number, number],
  family: string,
): ShownBox {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform
  const along = Math.hypot(a, b) || 1
  const up = Math.hypot(c, d) || 1
  const height = item.height || up
  // Along the baseline and up from it, as unit steps on the page.
  const ux = a / along
  const uy = b / along
  const vx = c / up
  const vy = d / up
  const [s0, s1] = share(item.str, c0, c1, family)
  // Room either side, so no edge of a letter shows even when the run is spaced out.
  const margin = height * 0.22
  const x0 = s0 * item.width - margin
  const x1 = s1 * item.width + margin
  const y0 = -height * 0.3
  const y1 = height * 1.05
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const) {
    const [px = 0, py = 0] = viewport.convertToViewportPoint(
      e + ux * x + vx * y,
      f + uy * x + vy * y,
    )
    xs.push(px)
    ys.push(py)
  }
  const pad = 1.5
  const left = Math.max(0, Math.min(...xs) - pad)
  const top = Math.max(0, Math.min(...ys) - pad)
  const right = Math.min(viewport.width, Math.max(...xs) + pad)
  const bottom = Math.min(viewport.height, Math.max(...ys) + pad)
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    width: Math.max(0, right - left) / viewport.width,
    height: Math.max(0, bottom - top) / viewport.height,
  }
}

/** A canvas's picture as bytes. */
export function canvasBytes(
  canvas: HTMLCanvasElement,
  type: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('This browser couldn’t save the page picture.'))
        else blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
      },
      type,
      quality,
    )
  })
}
