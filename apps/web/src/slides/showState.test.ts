import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { elapsedLabel, onKey, type ShowState, startShow } from './showState'

const press = (s: ShowState, ...keys: string[]) =>
  keys.reduce((state, key) => onKey(state, key).state, s)

describe('slide show keys (docs/PLAN-slides.md)', () => {
  const show = startShow(10, 'slides')

  it('goes forward and back, and stops at the ends (R5)', () => {
    expect(press(show, 'ArrowRight', ' ', 'PageDown', 'Enter').index).toBe(4)
    expect(press(show, 'ArrowRight', 'ArrowLeft').index).toBe(0)
    expect(press(show, 'ArrowLeft', 'Backspace').index).toBe(0)
    expect(press(show, 'End').index).toBe(9)
    expect(press(show, 'End', 'ArrowRight').index).toBe(9)
    expect(press(show, 'End', 'Home').index).toBe(0)
  })

  it('jumps to a slide by its number then Enter (R5)', () => {
    expect(press(show, '7', 'Enter').index).toBe(6)
    expect(press(show, '9', '9', 'Enter').index).toBe(9)
    expect(press(show, '0', 'Enter').index).toBe(0)
  })

  it('Esc leaves the show, or first drops typed digits (R5)', () => {
    expect(onKey(show, 'Escape').effect).toBe('close')
    const typing = press(show, '3')
    expect(onKey(typing, 'Escape')).toMatchObject({ effect: null, state: { jump: '' } })
  })

  it('B blacks out, and any key only brings it back (R8)', () => {
    const black = press(show, 'b')
    expect(black.black).toBe(true)
    const back = onKey(black, 'ArrowRight')
    expect(back.state).toMatchObject({ black: false, index: 0 })
    expect(onKey(black, 'Escape').effect).toBeNull()
  })

  it('L turns the laser on and off, P switches views, F asks for full screen (R6, R7)', () => {
    expect(press(show, 'l').laser).toBe(true)
    expect(press(show, 'l', 'L').laser).toBe(false)
    expect(press(show, 'p').mode).toBe('presenter')
    expect(press(show, 'p', 'P').mode).toBe('slides')
    expect(onKey(show, 'f').effect).toBe('fullscreen')
  })

  it('leaves other keys to the page', () => {
    expect(onKey(show, 'q').handled).toBe(false)
    expect(onKey(show, 'Tab').handled).toBe(false)
  })

  it('never shows a slide that isn’t there, whatever is pressed (property)', () => {
    const keys = fc.constantFrom(
      ...[
        'ArrowRight',
        'ArrowLeft',
        'Home',
        'End',
        'Enter',
        'Escape',
        'b',
        'l',
        'p',
        '0',
        '5',
        '9',
      ],
    )
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.array(keys, { maxLength: 40 }), (n, ks) => {
        const s = press(startShow(n, 'slides'), ...ks)
        expect(s.index).toBeGreaterThanOrEqual(0)
        expect(s.index).toBeLessThan(n)
      }),
    )
  })

  it('says how long the talk has run', () => {
    expect(elapsedLabel(0)).toBe('0:00')
    expect(elapsedLabel(65_400)).toBe('1:05')
    expect(elapsedLabel(3_725_000)).toBe('1:02:05')
  })
})
