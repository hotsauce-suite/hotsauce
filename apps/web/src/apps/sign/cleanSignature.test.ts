import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { cleanSignature, fitWithin, INK, type Pixels } from './cleanSignature'

/** A sheet of paper `w`×`h` in one grey, with dark rectangles drawn on it. */
function sheet(
  w: number,
  h: number,
  paper: number,
  marks: Array<{ x: number; y: number; w: number; h: number; ink?: number }>,
  shade?: (x: number, y: number) => number,
): Pixels {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = paper - (shade?.(x, y) ?? 0)
      for (const m of marks) {
        if (x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) v = m.ink ?? 20
      }
      const i = (y * w + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

const pixelAt = (p: Pixels, x: number, y: number) => {
  const i = (y * p.width + x) * 4
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]]
}

describe('cleanSignature (R2)', () => {
  it('turns the paper see-through, the ink blue-black, and crops to the ink', () => {
    const r = cleanSignature(sheet(400, 200, 245, [{ x: 100, y: 80, w: 150, h: 6 }]))
    if (!r.ok) throw new Error(r.reason)
    // Cropped close around the 150×6 stroke, with a small margin.
    expect(r.image.width).toBeGreaterThanOrEqual(150)
    expect(r.image.width).toBeLessThan(170)
    expect(r.image.height).toBeLessThan(30)
    expect(pixelAt(r.image, 0, 0)[3]).toBe(0)
    const mid = pixelAt(r.image, Math.floor(r.image.width / 2), Math.floor(r.image.height / 2))
    expect(mid).toEqual([...INK, 255])
  })

  it('keeps a shadow across the page as paper', () => {
    // Paper fading from 245 to about 165 left to right, as a phone photo by a window does.
    const r = cleanSignature(
      sheet(400, 200, 245, [{ x: 300, y: 90, w: 60, h: 5, ink: 60 }], (x) => x / 5),
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.image.width).toBeLessThan(80)
  })

  it('ignores a speck of dust when cropping', () => {
    const r = cleanSignature(
      sheet(400, 200, 245, [
        { x: 100, y: 80, w: 150, h: 6 },
        { x: 5, y: 5, w: 1, h: 1 },
      ]),
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.image.width).toBeLessThan(170)
  })

  it('says when there is no signature, or the picture is too dark', () => {
    expect(cleanSignature(sheet(200, 100, 240, []))).toEqual({ ok: false, reason: 'no-ink' })
    expect(cleanSignature(sheet(200, 100, 10, []))).toEqual({ ok: false, reason: 'too-dark' })
    // Paper with a signature away from the edges is fine.
    expect(cleanSignature(sheet(200, 100, 240, [{ x: 50, y: 40, w: 100, h: 5 }])).ok).toBe(true)
  })

  it('drops a dark desk around the photographed page', () => {
    // White paper in the middle, a near-black desk all round (30% of the frame).
    const w = 400
    const h = 300
    const desk = [
      { x: 0, y: 0, w, h: 40, ink: 15 },
      { x: 0, y: h - 40, w, h: 40, ink: 15 },
      { x: 0, y: 0, w: 40, h, ink: 15 },
      { x: w - 40, y: 0, w: 40, h, ink: 15 },
    ]
    const r = cleanSignature(sheet(w, h, 240, [...desk, { x: 120, y: 140, w: 160, h: 6 }]))
    if (!r.ok) throw new Error(r.reason)
    expect(r.image.width).toBeLessThan(185)
    expect(r.image.height).toBeLessThan(30)
  })

  it('keeps fainter strokes as the Ink slider goes up', () => {
    const faint = sheet(300, 120, 240, [{ x: 50, y: 50, w: 200, h: 5, ink: 190 }])
    expect(cleanSignature(faint, 0).ok).toBe(false)
    expect(cleanSignature(faint, 1).ok).toBe(true)
  })

  it('always gives ink-coloured pixels inside the original size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 80 }),
        fc.integer({ min: 20, max: 80 }),
        fc.integer({ min: 180, max: 255 }),
        fc.array(
          fc.record({
            x: fc.integer({ min: 0, max: 79 }),
            y: fc.integer({ min: 0, max: 79 }),
            w: fc.integer({ min: 1, max: 30 }),
            h: fc.integer({ min: 1, max: 10 }),
            ink: fc.integer({ min: 0, max: 120 }),
          }),
          { maxLength: 4 },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, h, paper, marks, strength) => {
          const r = cleanSignature(sheet(w, h, paper, marks), strength)
          if (!r.ok) return
          expect(r.image.width).toBeLessThanOrEqual(w)
          expect(r.image.height).toBeLessThanOrEqual(h)
          expect(r.image.data.length).toBe(r.image.width * r.image.height * 4)
          for (let i = 0; i < r.image.data.length; i += 4) {
            if (r.image.data[i + 3] === 0) continue
            expect([r.image.data[i], r.image.data[i + 1], r.image.data[i + 2]]).toEqual([...INK])
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('fitWithin', () => {
  it('shrinks to fit and never enlarges', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (w, h) => {
        const f = fitWithin(w, h, 1200, 400)
        expect(f.width).toBeLessThanOrEqual(Math.max(1, Math.min(w, 1200)))
        expect(f.height).toBeLessThanOrEqual(Math.max(1, Math.min(h, 400)))
      }),
    )
  })
})
