import { describe, expect, it } from 'vitest'
import { readProgress } from './links'

describe('readProgress (R7)', () => {
  const at = (furthest: number) => ({ anchor: 0, percent: furthest, furthest, updated: '' })

  it('says nothing for a link not started, and at least 1% once started', () => {
    expect(readProgress(null)).toBe('')
    expect(readProgress(at(0))).toBe('')
    expect(readProgress(at(0.4))).toBe('1% read')
  })

  it('rounds down, and says Read from 95%', () => {
    expect(readProgress(at(42.9))).toBe('42% read')
    expect(readProgress(at(94.9))).toBe('94% read')
    expect(readProgress(at(95))).toBe('Read')
    expect(readProgress(at(100))).toBe('Read')
  })
})
