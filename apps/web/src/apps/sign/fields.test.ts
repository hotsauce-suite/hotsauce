import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FIELD_TYPES, keepOnPage, moveField, newField, nextFieldId, resizeField } from './fields'

const LETTER = { width: 612, height: 792 }
const unit = fc.double({ min: -2, max: 3, noNaN: true })
const onPage = (f: { x: number; y: number; width: number; height: number }) =>
  f.x >= 0 && f.y >= 0 && f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001

describe('placing fields', () => {
  it('a new field sits centred where it was dropped, sized for the page', () => {
    const f = newField('signature', 's1', 1, { x: 0.5, y: 0.5 }, LETTER, [])
    expect(f).toMatchObject({ id: 'f1', signer: 's1', type: 'signature', page: 1, required: true })
    expect(f.x + f.width / 2).toBeCloseTo(0.5, 3)
    expect(f.width * LETTER.width).toBeCloseTo(180, 0)
    expect(newField('checkbox', 's1', 1, { x: 0.5, y: 0.5 }, LETTER, []).required).toBe(false)
  })

  it('never leaves a page, wherever it is dropped, moved or stretched', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FIELD_TYPES), unit, unit, unit, unit, (type, x, y, dx, dy) => {
        const f = newField(type, 's1', 1, { x, y }, LETTER, [])
        return onPage(f) && onPage(moveField(f, dx, dy)) && onPage(resizeField(f, dx, dy))
      }),
    )
  })

  it('keeps a field at least the smallest size the format takes', () => {
    fc.assert(
      fc.property(unit, unit, (w, h) => {
        const f = keepOnPage({ x: 0.2, y: 0.2, width: w, height: h })
        return f.width >= 0.01 && f.height >= 0.005 && onPage(f)
      }),
    )
  })

  it('gives each new field an id no other field has', () => {
    expect(nextFieldId([{ id: 'f1' }, { id: 'f2' }])).toBe('f3')
    expect(nextFieldId([{ id: 'f3' }])).toBe('f2')
    expect(nextFieldId([{ id: 'f2' }, { id: 'f1' }, { id: 'f3' }])).toBe('f4')
    expect(nextFieldId([{ id: 'f2' }])).toBe('f3')
  })
})
