// Reading the words on a page picture, for Make searchable and redacted pages
// (docs/PLAN-pdf-tools.md R5, R6). In the Mac app the app reads them with Apple's Vision
// (`hotsauceReadText`, apps/dictate-mac TextReading); elsewhere tesseract.js (Apache) with the
// English model, both served by our own server from /ocr/ and loaded only when needed.

import type { ReadText } from './tools'

export interface TextReader {
  /** Which reader, for the progress line. */
  name: 'mac' | 'web'
  read: (canvas: HTMLCanvasElement) => Promise<ReadText[]>
  close: () => Promise<void>
}

interface ReplyHandler {
  postMessage: (body: unknown) => Promise<unknown>
}

function macHandler(): ReplyHandler | null {
  const w = window as { webkit?: { messageHandlers?: Record<string, ReplyHandler | undefined> } }
  return w.webkit?.messageHandlers?.hotsauceReadText ?? null
}

const fraction = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= -0.01 && v <= 1.01
    ? Math.min(1, Math.max(0, v))
    : null

/** The Mac app's answer, checked: anything malformed is left out. */
export function parseMacLines(answer: unknown): ReadText[] {
  const lines = (answer as { lines?: unknown } | null)?.lines
  if (!Array.isArray(lines)) throw new Error('The Mac couldn’t read this page.')
  const out: ReadText[] = []
  for (const l of lines.slice(0, 5000)) {
    const line = l as Record<string, unknown>
    const text = typeof line.text === 'string' ? line.text.slice(0, 2000) : ''
    const x = fraction(line.x)
    const y = fraction(line.y)
    const width = fraction(line.width)
    const height = fraction(line.height)
    if (!text.trim() || x === null || y === null || width === null || height === null) continue
    out.push({ text, x, y, width, height })
  }
  return out
}

function base64Png(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** The Mac app's Vision reader, or null outside the Mac app (or in an older one). */
export function macReader(): TextReader | null {
  const handler = macHandler()
  if (!handler) return null
  return {
    name: 'mac',
    read: async (canvas) => parseMacLines(await handler.postMessage({ png: base64Png(canvas) })),
    close: async () => {},
  }
}

/** tesseract.js in the browser, with the English model. */
export async function webReader(): Promise<TextReader> {
  const { createWorker, OEM } = await import('tesseract.js')
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/',
    langPath: '/ocr/',
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
  })
  return {
    name: 'web',
    read: async (canvas) => {
      const { data } = await worker.recognize(canvas, {}, { blocks: true })
      const out: ReadText[] = []
      const { width, height } = canvas
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            const text = line.text.replace(/\s+/g, ' ').trim()
            if (!text || line.confidence < 30) continue
            const b = line.bbox
            out.push({
              text,
              x: b.x0 / width,
              y: b.y0 / height,
              width: (b.x1 - b.x0) / width,
              height: (b.y1 - b.y0) / height,
            })
          }
        }
      }
      return out
    },
    close: async () => {
      await worker.terminate()
    },
  }
}

/** The Mac's reader when there is one, else the browser's. */
export async function textReader(): Promise<TextReader> {
  return macReader() ?? (await webReader())
}
