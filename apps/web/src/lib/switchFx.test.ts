import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SWITCH_FX,
  drawRipple,
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
    expect(ring?.style.left).toBe(`${100 - 180}px`)
    expect(ring?.style.top).toBe(`${50 - 180}px`)
    expect(document.querySelectorAll('[data-testid="switch-ripple"]')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 600))
    expect(document.querySelectorAll('[data-testid="switch-ripple"]')).toHaveLength(0)
  })
})
