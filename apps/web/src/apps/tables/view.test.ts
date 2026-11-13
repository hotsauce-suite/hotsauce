import { describe, expect, it } from 'vitest'
import {
  asNumber,
  compareValues,
  isTicked,
  linkHref,
  parseClipboard,
  toClipboard,
  viewRows,
} from './view'

const grid = [
  ['Name', 'Score', 'Team'],
  ['b', '10', 'Lab'],
  ['a', '9', 'Ops'],
  ['c', '', 'Lab'],
  ['d', '$1,000', 'lab'],
]
const value = (r: number, c: number) => grid[r]?.[c] ?? ''

describe('the rows on screen', () => {
  it('keeps the file order with no sort or filter', () => {
    expect(viewRows(5, value, null, [])).toEqual([1, 2, 3, 4])
  })

  it('sorts numbers by size, empty cells last either way', () => {
    expect(viewRows(5, value, { column: 1, dir: 'asc' }, [])).toEqual([2, 1, 4, 3])
    expect(viewRows(5, value, { column: 1, dir: 'desc' }, [])).toEqual([4, 1, 2, 3])
    expect(viewRows(5, value, { column: 0, dir: 'desc' }, [])).toEqual([4, 3, 1, 2])
  })

  it('filters by text in a column, any case', () => {
    expect(viewRows(5, value, null, [{ column: 2, text: 'LAB' }])).toEqual([1, 3, 4])
    expect(viewRows(5, value, { column: 0, dir: 'asc' }, [{ column: 2, text: 'lab' }])).toEqual([
      1, 3, 4,
    ])
  })
})

describe('cells', () => {
  it('reads numbers the way people type them', () => {
    expect(asNumber('$1,000')).toBe(1000)
    expect(asNumber('40%')).toBe(0.4)
    expect(asNumber('-3.5')).toBe(-3.5)
    expect(asNumber('12 apples')).toBeNull()
    expect(compareValues('9', '10')).toBeLessThan(0)
    expect(compareValues('item 2', 'item 10')).toBeLessThan(0)
  })

  it('knows ticks and links', () => {
    expect(['TRUE', 'yes', 'x', '1'].every(isTicked)).toBe(true)
    expect(isTicked('FALSE')).toBe(false)
    expect(linkHref('https://example.test/a', 'link')).toBe('https://example.test/a')
    expect(linkHref('javascript:alert(1)', 'link')).toBeNull()
    expect(linkHref('a@example.test', 'person')).toBe('mailto:a@example.test')
  })
})

describe('the clipboard', () => {
  it('reads what Sheets and Excel copy, quoted cells included', () => {
    expect(parseClipboard('a\tb\r\n1\t"two\nlines"\n')).toEqual([
      ['a', 'b'],
      ['1', 'two\nlines'],
    ])
    expect(parseClipboard('one cell')).toEqual([['one cell']])
  })

  it('round-trips', () => {
    const rows = [
      ['a', 'tab\there'],
      ['say "hi"', ''],
    ]
    expect(parseClipboard(toClipboard(rows))).toEqual(rows)
  })
})
