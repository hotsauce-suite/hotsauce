import { describe, expect, it } from 'vitest'
import { activeLine, formatDuration, formatWhen } from './format'
import { loadSpeed, SPEEDS, saveSpeed, stepSpeed } from './speed'

describe('formatDuration', () => {
  it('writes minutes and seconds, and hours when there are any', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_400)).toBe('1:05')
    expect(formatDuration(3_723_000)).toBe('1:02:03')
    expect(formatDuration(null)).toBe('0:00')
  })
})

describe('formatWhen', () => {
  it('says today and yesterday', () => {
    const now = new Date(2026, 10, 10, 15, 0)
    expect(formatWhen(new Date(2026, 10, 10, 9, 5).toISOString(), now)).toMatch(/^Today, /)
    expect(formatWhen(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toMatch(/^Yesterday, /)
    expect(formatWhen(new Date(2026, 10, 1, 9, 5).toISOString(), now)).toMatch(/Nov 1/)
  })
})

describe('activeLine', () => {
  it('finds the line that started last at or before the time', () => {
    const starts = [0, 2, 4, 6]
    expect(activeLine(starts, 0)).toBe(0)
    expect(activeLine(starts, 3.9)).toBe(1)
    expect(activeLine(starts, 4)).toBe(2)
    expect(activeLine(starts, 99)).toBe(3)
    expect(activeLine([1, 2], 0.5)).toBe(-1)
    expect(activeLine([], 3)).toBe(-1)
  })
})

describe('speed', () => {
  it('offers the seven speeds and steps through them, stopping at the ends', () => {
    expect(SPEEDS).toEqual([0.5, 1, 1.2, 1.5, 1.75, 2, 2.5])
    expect(stepSpeed(1, 1)).toBe(1.2)
    expect(stepSpeed(2.5, 1)).toBe(2.5)
    expect(stepSpeed(0.5, -1)).toBe(0.5)
    expect(stepSpeed(1.5, -1)).toBe(1.2)
  })

  it('remembers the speed, ignoring anything that isn’t one of them', () => {
    localStorage.clear()
    expect(loadSpeed()).toBe(1)
    saveSpeed(1.75)
    expect(loadSpeed()).toBe(1.75)
    localStorage.setItem('hearth.clips.speed', '9')
    expect(loadSpeed()).toBe(1)
  })
})
