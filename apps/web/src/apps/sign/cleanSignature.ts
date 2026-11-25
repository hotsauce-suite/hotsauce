// Turns a photo or scan of a signature into ink on a see-through background, cropped to the ink
// (docs/PLAN-sign-saved-signature.md R2). Pure: works on RGBA pixels, so it runs in tests without
// a canvas. The DOM side (decoding the file, scaling, PNG) is in `uploadSignature.ts`.

export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type CleanResult = { ok: true; image: Pixels } | { ok: false; reason: 'no-ink' | 'too-dark' }

/** Blue-black, the same ink as the drawing pad, so every signature looks alike on the PDF. */
export const INK = [0x05, 0x0a, 0x1a] as const

/** The Ink slider's default, between 0 (only the darkest strokes) and 1 (faint pencil too). */
export const DEFAULT_STRENGTH = 0.5

/** The slow part of cleaning, done once per picture: each pixel's brightness and its paper's. */
export interface Prepared {
  width: number
  height: number
  lum: Float64Array
  bg: Float64Array
}

export function prepare(src: Pixels): Prepared {
  const { width, height, data } = src
  const n = width * height
  const lum = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = (data[i * 4 + 3] ?? 255) / 255
    const y =
      0.2126 * (data[i * 4] ?? 0) +
      0.7152 * (data[i * 4 + 1] ?? 0) +
      0.0722 * (data[i * 4 + 2] ?? 0)
    // A see-through pixel counts as white paper.
    lum[i] = y * a + 255 * (1 - a)
  }
  const r = Math.max(8, Math.round(Math.min(width, height) / 6))
  return { width, height, lum, bg: localMean(lum, width, height, r) }
}

/**
 * Each pixel is compared with the paper around it (a local average, so a shadow across the page
 * stays paper), and kept as ink by how much darker it is. `strength` moves the cut-off. Ink that
 * touches the picture's edge is a desk or table around the sheet, not the signature, and is
 * dropped.
 */
export function cleanSignature(src: Pixels | Prepared, strength = DEFAULT_STRENGTH): CleanResult {
  const p = 'lum' in src ? src : prepare(src)
  const { width, height, lum, bg } = p
  if (width < 1 || height < 1) return { ok: false, reason: 'no-ink' }
  const n = width * height
  const s = Math.min(1, Math.max(0, strength))
  const low = 0.3 - 0.22 * s
  const high = low + 0.15
  const alpha = new Uint8ClampedArray(n)
  let dark = 0
  for (let i = 0; i < n; i++) {
    const paper = Math.max(bg[i] ?? 255, 1)
    const d = (paper - (lum[i] ?? 255)) / paper
    const a = d <= low ? 0 : d >= high ? 1 : (d - low) / (high - low)
    alpha[i] = Math.round(a * 255)
    if ((lum[i] ?? 255) < 60) dark++
  }
  if (dark > n * 0.6) return { ok: false, reason: 'too-dark' }
  clearEdgeInk(alpha, width, height)
  let inked = 0
  for (let i = 0; i < n; i++) if ((alpha[i] ?? 0) >= 128) inked++
  if (inked < Math.max(4, n * 0.0002)) return { ok: false, reason: 'no-ink' }

  const box = inkBox(alpha, width, height)
  if (!box) return { ok: false, reason: 'no-ink' }
  const pad = Math.max(2, Math.round(Math.min(box.w, box.h) * 0.06))
  const x0 = Math.max(0, box.x - pad)
  const y0 = Math.max(0, box.y - pad)
  const x1 = Math.min(width, box.x + box.w + pad)
  const y1 = Math.min(height, box.y + box.h + pad)
  const w = x1 - x0
  const h = y1 - y0
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[(y + y0) * width + (x + x0)] ?? 0
      if (a === 0) continue
      const o = (y * w + x) * 4
      out[o] = INK[0]
      out[o + 1] = INK[1]
      out[o + 2] = INK[2]
      out[o + 3] = a
    }
  }
  return { ok: true, image: { data: out, width: w, height: h } }
}

/** Clears every run of ink joined to the picture's edge (the desk around a photographed page). */
function clearEdgeInk(alpha: Uint8ClampedArray, width: number, height: number): void {
  const stack: number[] = []
  const push = (i: number) => {
    if ((alpha[i] ?? 0) === 0) return
    alpha[i] = 0
    stack.push(i)
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (stack.length > 0) {
    const i = stack.pop() as number
    const x = i % width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (i >= width) push(i - width)
    if (i < width * (height - 1)) push(i + width)
  }
}

/**
 * The box around the ink, leaving out stray specks: a row or column only counts when it has
 * a few solid ink pixels, so a dot of dust in a corner doesn't stretch the crop.
 */
export function inkBox(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  const rows = new Uint32Array(height)
  const cols = new Uint32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((alpha[y * width + x] ?? 0) < 128) continue
      rows[y] = (rows[y] ?? 0) + 1
      cols[x] = (cols[x] ?? 0) + 1
    }
  }
  const span = (counts: Uint32Array, min: number) => {
    let first = -1
    let last = -1
    for (let i = 0; i < counts.length; i++) {
      if ((counts[i] ?? 0) < min) continue
      if (first < 0) first = i
      last = i
    }
    return first < 0 ? null : { first, last }
  }
  const ys = span(rows, Math.max(2, Math.round(width * 0.002)))
  const xs = span(cols, Math.max(2, Math.round(height * 0.004)))
  if (!ys || !xs) return null
  return { x: xs.first, y: ys.first, w: xs.last - xs.first + 1, h: ys.last - ys.first + 1 }
}

/** The average of each pixel's square neighbourhood, from a summed-area table. */
function localMean(v: Float64Array, width: number, height: number, r: number): Float64Array {
  const sum = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += v[y * width + x] ?? 0
      sum[(y + 1) * (width + 1) + x + 1] = (sum[y * (width + 1) + x + 1] ?? 0) + row
    }
  }
  const out = new Float64Array(width * height)
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - r)
    const yb = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const xa = Math.max(0, x - r)
      const xb = Math.min(width, x + r + 1)
      const total =
        (sum[yb * (width + 1) + xb] ?? 0) -
        (sum[ya * (width + 1) + xb] ?? 0) -
        (sum[yb * (width + 1) + xa] ?? 0) +
        (sum[ya * (width + 1) + xa] ?? 0)
      // Mostly-ink neighbourhoods pull the mean down; paper is never darker than the pixel's
      // brightest plausible surroundings, so lift it toward white a little.
      out[y * width + x] = Math.min(255, (total / ((xb - xa) * (yb - ya))) * 1.04)
    }
  }
  return out
}

/** The size to draw an image so it fits inside `maxW` by `maxH`, never larger than it is. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(1, maxW / w, maxH / h)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}
