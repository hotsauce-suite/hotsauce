import { afterEach, describe, expect, it } from 'vitest'
import type { ReadingPlace } from '../../api/links'
import { forgetRecentPlaces, measurePlace, withRecentPlace } from './useReadingPlace'

afterEach(forgetRecentPlaces)

/** A scroller and a copy of blocks laid out at fixed heights, as a browser would report them. */
function layout(scrollTop: number, viewHeight: number, blockHeights: number[]) {
  const box = (top: number, height: number) => ({
    getBoundingClientRect: () => ({ top, bottom: top + height, height }) as DOMRect,
  })
  let y = -scrollTop
  const blocks = blockHeights.map((h) => {
    const b = box(y, h)
    y += h
    return b
  })
  const total = blockHeights.reduce((a, h) => a + h, 0)
  const scroller = box(0, viewHeight) as unknown as HTMLElement
  const body = {
    ...box(-scrollTop, total),
    children: blocks,
  } as unknown as HTMLElement
  return { scroller, body }
}

describe('measurePlace', () => {
  it('names the first block still below the top line, and how far the screen has got', () => {
    const { scroller, body } = layout(0, 500, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100])
    expect(measurePlace(scroller, body)).toEqual({ anchor: 0, percent: 50 })
    const later = layout(300, 500, Array(10).fill(100))
    expect(measurePlace(later.scroller, later.body)).toEqual({ anchor: 3, percent: 80 })
  })

  it('agrees with the room left when scrolling back, so a reopen never walks up a block', () => {
    // Block 3 restored 16 px below the top: block 2 ends above that line, so 3 is still the place.
    const { scroller, body } = layout(284, 500, Array(10).fill(100))
    expect(measurePlace(scroller, body).anchor).toBe(3)
  })
})

describe('withRecentPlace', () => {
  const link = (reading: ReadingPlace | null) => ({ id: 'L1', reading })

  it('leaves a link alone with nothing sent from this tab', () => {
    expect(withRecentPlace(link(null))).toEqual(link(null))
  })
})
