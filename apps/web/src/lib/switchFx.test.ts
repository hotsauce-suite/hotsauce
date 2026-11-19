import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SWITCH_FX,
  drawRipple,
  reachFrom,
  readSwitchFx,
  SWITCH_FX_KEY,
  switchEffects,
  writeSwitchFx,
} from './switchFx'

function memory() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

afterEach(() => {
  for (const el of document.querySelectorAll('[data-testid="switch-ripple"]')) el.remove()
})

describe('tool switch effects (PLAN-switch-ripple)', () => {
  it('R1, R4: ripple on and sound off until the member chooses', () => {
    expect(readSwitchFx(memory())).toEqual({ ripple: true, sound: false })
    expect(readSwitchFx(null)).toEqual(DEFAULT_SWITCH_FX)
  })

  it('R6: remembers each choice in this browser', () => {
    const store = memory()
    writeSwitchFx({ sound: true }, store)
    writeSwitchFx({ ripple: false }, store)
    expect(readSwitchFx(store)).toEqual({ ripple: false, sound: true })
  })

  it('ignores a damaged saved value', () => {
    const store = memory()
    store.setItem(SWITCH_FX_KEY, '{not json')
    expect(readSwitchFx(store)).toEqual(DEFAULT_SWITCH_FX)
    store.setItem(SWITCH_FX_KEY, '{"ripple":"yes","sound":1}')
    expect(readSwitchFx(store)).toEqual(DEFAULT_SWITCH_FX)
  })

  it('R3, R5: reduced motion stops the ripple and recording stops the sound, whatever is chosen', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (r, s, rm, rec) => {
        const fx = switchEffects({ ripple: r, sound: s }, { reducedMotion: rm, recording: rec })
        expect(fx.ripple).toBe(r && !rm)
        expect(fx.sound).toBe(s && !rec)
      }),
    )
  })

  it('R2: the ripple sits on the click, ignores the pointer and removes itself', async () => {
    const ring = drawRipple(100, 50)
    expect(ring).not.toBeNull()
    expect(ring?.getAttribute('aria-hidden')).toBe('true')
    const r = Number.parseFloat(ring?.style.width ?? '0') / 2
    expect(Number.parseFloat(ring?.style.left ?? '') + r).toBeCloseTo(100)
    expect(Number.parseFloat(ring?.style.top ?? '') + r).toBeCloseTo(50)
    // R7: big enough to clear the farthest corner of the window.
    expect(r).toBeGreaterThanOrEqual(
      reachFrom(100, 50, window.innerWidth, window.innerHeight) - 0.01,
    )
    expect(document.querySelectorAll('[data-testid="switch-ripple"]')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 950))
    expect(document.querySelectorAll('[data-testid="switch-ripple"]')).toHaveLength(0)
  })
})

describe('reachFrom (R7)', () => {
  it('clears every corner of the window from any click inside it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 4000 }),
        fc.integer({ min: 200, max: 3000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, h, fx, fy) => {
          const x = w * fx
          const y = h * fy
          const r = reachFrom(x, y, w, h)
          for (const [cx, cy] of [
            [0, 0],
            [w, 0],
            [0, h],
            [w, h],
          ] as const)
            expect(r).toBeGreaterThan(Math.hypot(cx - x, cy - y))
        },
      ),
    )
  })
})
