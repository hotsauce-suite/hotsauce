import { describe, expect, it } from 'vitest'
import { parseRange } from './clips.js'

describe('parseRange', () => {
  it('reads the three forms a browser sends', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('serves the whole file for no or an odd header, and refuses one past the end', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable')
  })
})
