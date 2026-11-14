import { describe, expect, it } from 'vitest'
import { daysSinceMonday, endOfWeek, monthGrid, startOfWeek } from './weeks.js'

describe('weeks run Monday to Sunday (W1)', () => {
  it('finds the Monday on or before a date', () => {
    expect(startOfWeek('2026-11-13')).toBe('2026-11-09') // Friday
    expect(startOfWeek('2026-11-09')).toBe('2026-11-09') // Monday
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09') // Sunday ends the week
    expect(startOfWeek('2026-03-01')).toBe('2026-02-23') // across a month
  })

  it('finds the Sunday that ends the week', () => {
    expect(endOfWeek('2026-11-13')).toBe('2026-11-15')
    expect(endOfWeek('2026-11-15')).toBe('2026-11-15')
    expect(endOfWeek('2026-12-29')).toBe('2027-01-03')
  })

  it('counts days since Monday', () => {
    expect(daysSinceMonday('2026-11-09')).toBe(0)
    expect(daysSinceMonday('2026-11-15')).toBe(6)
  })

  it('lays a month out in Monday-to-Sunday rows', () => {
    const nov = monthGrid('2026-11') // Nov 1 2026 is a Sunday
    expect(nov[0]).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
    expect(nov.at(-1)?.at(-1)).toBe('2026-12-06')
    expect(nov).toHaveLength(6)
    for (const row of nov) expect(daysSinceMonday(row[0] as string)).toBe(0)
    // February 2027 starts on a Monday and ends on a Sunday: exactly four rows.
    expect(monthGrid('2027-02')).toHaveLength(4)
  })
})
