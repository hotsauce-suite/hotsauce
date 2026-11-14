// Pictures are shrunk in the browser before they're sent (docs/PLAN-feedback-screenshots.md S8):
// at most 2000 px wide, PNG for screenshots unless a JPEG is much smaller, aiming under 1.5 MB.

export const MAX_SHOT_WIDTH = 2000
const AIM_BYTES = 1.5 * 1024 * 1024
const KEEP_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface Size {
  width: number
  height: number
}

export function fitWidth(width: number, height: number, max = MAX_SHOT_WIDTH): Size {
  if (width <= max) return { width, height }
  return { width: max, height: Math.round((height * max) / width) }
}

interface Tools {
  measure: (blob: Blob) => Promise<Size>
  encode: (size: Size, type: string, quality?: number) => Promise<Blob>
}

export async function shrinkImage(blob: Blob, tools?: Tools): Promise<Blob> {
  let source: ImageBitmap | null = null
  const t: Tools = tools ?? {
    measure: async (b) => {
      source = await createImageBitmap(b)
      return { width: source.width, height: source.height }
    },
    encode: (size, type, quality) => encodeBitmap(source as ImageBitmap, size, type, quality),
  }
  try {
    const size = await t.measure(blob)
    if (size.width <= MAX_SHOT_WIDTH && blob.size <= AIM_BYTES && KEEP_TYPES.has(blob.type)) {
      return blob
    }
    const fit = fitWidth(size.width, size.height)
    const png = await t.encode(fit, 'image/png')
    if (png.size <= AIM_BYTES) return png
    const jpeg = await t.encode(fit, 'image/jpeg', 0.85)
    return jpeg.size < png.size ? jpeg : png
  } catch {
    // Not a picture the browser can draw: the server decides whether it's acceptable.
    return blob
  } finally {
    ;(source as ImageBitmap | null)?.close()
  }
}

function encodeBitmap(bitmap: ImageBitmap, size: Size, type: string, quality?: number) {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('No canvas'))
  if (type === 'image/jpeg') {
    // JPEG has no transparency; a white page reads better than black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, size.width, size.height)
  }
  ctx.drawImage(bitmap, 0, 0, size.width, size.height)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode'))), type, quality),
  )
}
