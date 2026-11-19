// The liquid wave behind the tool-switch ripple (docs/PLAN-switch-ripple.md R7): for a moment
// the whole window bends like water as a wave runs out from the click to every corner.
//
// How: an SVG displacement filter on the app's root. Its map is a small picture of one ring of
// "push outwards, pull back" (red = sideways, green = up and down, mid-grey = still), drawn once
// on a canvas. Each frame moves and grows that picture under the click and eases the strength
// down, so the page's own pixels refract as the ring passes. Nothing is copied or redrawn by us,
// so it works on any page, and it never takes the pointer.

const SVG_NS = 'http://www.w3.org/2000/svg'
const FILTER_ID = 'hotsauce-wave'
/** How long the wave takes to reach the farthest corner. */
export const WAVE_MS = 750
/** The strongest bend, in CSS pixels, at the start. */
export const WAVE_STRENGTH = 40
/** The size of the map picture; it's stretched, so this only sets how smooth the ring is. */
const MAP_SIZE = 512

let mapUrl: string | null = null

/**
 * A ring that refracts like the front of a water wave: pixels just inside are pushed outwards and
 * those just outside pulled in, fading to still at the centre and the edge.
 */
export function waveMapPixels(size = MAP_SIZE): Uint8ClampedArray {
  const px = new Uint8ClampedArray(size * size * 4)
  const c = (size - 1) / 2
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (i - c) / c
      const dy = (j - c) / c
      const d = Math.hypot(dx, dy)
      // One crest and trough around 80% of the radius, quiet elsewhere.
      const u = (d - 0.78) / 0.2
      const a = d > 0 && d < 1 ? -u * Math.exp(-u * u) * 1.65 : 0
      const k = d > 0 ? a / d : 0
      const at = (j * size + i) * 4
      px[at] = 128 + 127 * dx * k
      px[at + 1] = 128 + 127 * dy * k
      px[at + 2] = 128
      px[at + 3] = 255
    }
  }
  return px
}

function waveMap(doc: Document): string | null {
  if (mapUrl) return mapUrl
  try {
    const canvas = doc.createElement('canvas')
    canvas.width = MAP_SIZE
    canvas.height = MAP_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const image = ctx.createImageData(MAP_SIZE, MAP_SIZE)
    image.data.set(waveMapPixels())
    ctx.putImageData(image, 0, 0)
    mapUrl = canvas.toDataURL('image/png')
    return mapUrl
  } catch {
    return null
  }
}

interface WaveFilter {
  svg: SVGSVGElement
  image: SVGFEImageElement
  displace: SVGFEDisplacementMapElement
}

function buildFilter(doc: Document, url: string): WaveFilter {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.dataset.testid = 'switch-wave'
  const filter = doc.createElementNS(SVG_NS, 'filter')
  filter.id = FILTER_ID
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', '100%')
  filter.setAttribute('height', '100%')
  const flood = doc.createElementNS(SVG_NS, 'feFlood')
  flood.setAttribute('flood-color', 'rgb(128,128,128)')
  flood.setAttribute('result', 'still')
  const image = doc.createElementNS(SVG_NS, 'feImage') as SVGFEImageElement
  image.setAttribute('href', url)
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url)
  image.setAttribute('preserveAspectRatio', 'none')
  image.setAttribute('result', 'ring')
  const over = doc.createElementNS(SVG_NS, 'feComposite')
  over.setAttribute('in', 'ring')
  over.setAttribute('in2', 'still')
  over.setAttribute('operator', 'over')
  over.setAttribute('result', 'map')
  const displace = doc.createElementNS(SVG_NS, 'feDisplacementMap') as SVGFEDisplacementMapElement
  displace.setAttribute('in', 'SourceGraphic')
  displace.setAttribute('in2', 'map')
  displace.setAttribute('xChannelSelector', 'R')
  displace.setAttribute('yChannelSelector', 'G')
  displace.setAttribute('scale', '0')
  filter.append(flood, image, over, displace)
  svg.append(filter)
  return { svg, image, displace }
}

let running: (() => void) | null = null

/**
 * How many waves in a row ran too slowly in this browser. At `SLOW_LIMIT` the wave stops for good
 * here and the light band plays alone; a smooth wave sets it back to none.
 */
export const WAVE_SLOW_KEY = 'hotsauce:switch-wave-slow'
export const SLOW_LIMIT = 3
/** Frames slower than this, typically (about 22 a second), mean the device can't keep up. */
const SLOW_FRAME_MS = 45

function slowRuns(view: Window): number {
  try {
    return Number(view.localStorage.getItem(WAVE_SLOW_KEY)) || 0
  } catch {
    return 0
  }
}

function setSlowRuns(view: Window, n: number): void {
  try {
    if (n === 0) view.localStorage.removeItem(WAVE_SLOW_KEY)
    else view.localStorage.setItem(WAVE_SLOW_KEY, String(n))
  } catch {}
}

/**
 * Runs one wave from (x, y) across `target` (the app root). A new wave replaces one still running.
 * Returns false when it can't run here (no canvas), so the caller keeps just the light ring.
 */
export function playWave(
  x: number,
  y: number,
  target: HTMLElement | null,
  doc: Document = document,
): boolean {
  const view = doc.defaultView
  if (!target || !view || typeof view.requestAnimationFrame !== 'function') return false
  if (slowRuns(view) >= SLOW_LIMIT) return false
  const url = waveMap(doc)
  if (!url) return false
  running?.()
  const { svg, image, displace } = buildFilter(doc, url)
  doc.body.append(svg)
  const w = view.innerWidth
  const h = view.innerHeight
  // Far enough that the ring's quiet edge clears the farthest corner.
  const reach =
    Math.max(
      Math.hypot(x, y),
      Math.hypot(w - x, y),
      Math.hypot(x, h - y),
      Math.hypot(w - x, h - y),
    ) * 1.3
  const before = target.style.filter
  const start = view.performance.now()
  let frame = 0
  const gaps: number[] = []
  let last = start
  // A backstop: a hidden window runs no frames, and the page must never stay bent.
  const backstop = view.setTimeout(() => stop(), WAVE_MS + 250)
  const stop = () => {
    view.clearTimeout(backstop)
    view.cancelAnimationFrame(frame)
    target.style.filter = before
    svg.remove()
    if (running === stop) running = null
  }
  running = stop
  // Timed by the page's clock, not the frame's stamp, so the two can't disagree.
  const step = () => {
    const now = view.performance.now()
    const t = Math.min(1, (now - start) / WAVE_MS)
    // Fast out, settling: the wave races at first and slows as it spreads.
    const r = Math.max(24, reach * (1 - (1 - t) ** 2.2))
    image.setAttribute('x', String(x - r))
    image.setAttribute('y', String(y - r))
    image.setAttribute('width', String(2 * r))
    image.setAttribute('height', String(2 * r))
    // Swells as it leaves the click, then calms as it spreads.
    const swell = Math.min(1, t / 0.12)
    displace.setAttribute('scale', String(WAVE_STRENGTH * swell * (1 - t) ** 1.3))
    if (now > last) gaps.push(now - last)
    last = now
    // Too slow to look like water on this device: stop now and keep to the light ring after. The
    // middle gap, so one long frame while the new tool draws doesn't count against it.
    if (gaps.length === 7 && ([...gaps].sort((a, b) => a - b)[3] ?? 0) > SLOW_FRAME_MS) {
      setSlowRuns(view, slowRuns(view) + 1)
      stop()
      return
    }
    if (gaps.length === 7) setSlowRuns(view, 0)
    if (t < 1) frame = view.requestAnimationFrame(step)
    else stop()
  }
  step()
  target.style.filter = `url(#${FILTER_ID})`
  return true
}
