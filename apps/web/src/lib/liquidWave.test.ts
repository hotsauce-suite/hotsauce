import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playWave, SLOW_LIMIT, WAVE_MS, WAVE_SLOW_KEY, waveMapPixels } from './liquidWave'

// docs/PLAN-switch-ripple.md R7, R8.

const SIZE = 64
const px = waveMapPixels(SIZE)
const at = (i: number, j: number) => {
  const k = (j * SIZE + i) * 4
  return { r: px[k] ?? 0, g: px[k + 1] ?? 0 }
}

describe('the wave map', () => {
  it('is still (mid-grey) at the centre and at the corners, so only the ring bends the page', () => {
    for (const [i, j] of [
      [0, 0],
      [SIZE - 1, 0],
      [0, SIZE - 1],
      [SIZE - 1, SIZE - 1],
    ] as const) {
      expect(at(i, j)).toEqual({ r: 128, g: 128 })
    }
    const c = Math.floor(SIZE / 2)
    expect(Math.abs(at(c, c).r - 128)).toBeLessThanOrEqual(1)
  })

  it('only pushes along the line from the centre: no sideways twist anywhere', () => {
    const c = (SIZE - 1) / 2
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SIZE - 1 }),
        fc.integer({ min: 0, max: SIZE - 1 }),
        (i, j) => {
          const { r, g } = at(i, j)
          const vx = r - 128
          const vy = g - 128
          // The push is parallel to (i - c, j - c): their cross product is (nearly) zero.
          const cross = vx * (j - c) - vy * (i - c)
          expect(Math.abs(cross)).toBeLessThanOrEqual(Math.hypot(i - c, j - c) * 1.5 + 1)
        },
      ),
    )
  })

  it('fades to still just inside its rim, so the wave has no hard edge', () => {
    const big = waveMapPixels(256)
    const c = 255 / 2
    for (let deg = 0; deg < 360; deg += 15) {
      const t = (deg * Math.PI) / 180
      const i = Math.round(c + Math.cos(t) * c * 0.99)
      const j = Math.round(c + Math.sin(t) * c * 0.99)
      const k = (j * 256 + i) * 4
      expect(Math.abs((big[k] ?? 0) - 128)).toBeLessThanOrEqual(2)
      expect(Math.abs((big[k + 1] ?? 0) - 128)).toBeLessThanOrEqual(2)
    }
  })

  it('has a real crest: some pixels push hard', () => {
    let max = 0
    for (let k = 0; k < px.length; k += 4) max = Math.max(max, Math.abs((px[k] ?? 128) - 128))
    expect(max).toBeGreaterThan(60)
  })
})

describe('playWave', () => {
  afterEach(() => {
    localStorage.removeItem(WAVE_SLOW_KEY)
    vi.restoreAllMocks()
  })

  it('bends the target with a filter while it runs, then puts everything back', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    // jsdom has no canvas: give it a tiny one so the map can be made.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==')
    expect(playWave(10, 10, root)).toBe(true)
    expect(root.style.filter).toContain('#hotsauce-wave')
    expect(document.querySelector('[data-testid="switch-wave"]')).not.toBeNull()
    await new Promise((r) => setTimeout(r, WAVE_MS + 300))
    expect(root.style.filter).toBe('')
    expect(document.querySelector('[data-testid="switch-wave"]')).toBeNull()
    root.remove()
  })

  it('stays off on a device where it ran too slowly twice in a row (R8)', () => {
    localStorage.setItem(WAVE_SLOW_KEY, String(SLOW_LIMIT))
    const root = document.createElement('div')
    expect(playWave(10, 10, root)).toBe(false)
    expect(root.style.filter).toBe('')
  })
})
