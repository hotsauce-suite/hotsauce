import { describe, expect, it } from 'vitest'
import { currentRound, instantOf, recentRounds, summaryDeadline } from './schedule.js'

const fm = {
  days: ['mon' as const, 'fri' as const],
  time: '09:00',
  created: '2026-11-01T00:00:00.000Z',
  tz: 'America/New_York',
}

describe('instantOf', () => {
  it('reads the wall clock in the zone, either side of a DST change', () => {
    expect(instantOf('2026-11-16', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-11-16T14:00:00.000Z',
    )
    expect(instantOf('2026-07-06', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-06T13:00:00.000Z',
    )
    expect(instantOf('2026-11-16', '09:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-16T03:30:00.000Z',
    )
  })
})

describe('currentRound (R4)', () => {
  it('is the previous round before the time on a scheduled day, today’s after', () => {
    const before = currentRound(fm, new Date('2026-11-16T13:59:00Z'), 'America/New_York')
    expect(before?.date).toBe('2026-11-13')
    const after = currentRound(fm, new Date('2026-11-16T14:00:00Z'), 'America/New_York')
    expect(after?.date).toBe('2026-11-16')
  })

  it('uses each member’s own zone', () => {
    // 05:00Z Monday: 10:30 AM in Kolkata (asked), still Sunday night in New York.
    const at = new Date('2026-11-16T05:00:00Z')
    expect(currentRound(fm, at, 'Asia/Kolkata')?.date).toBe('2026-11-16')
    expect(currentRound(fm, at, 'America/New_York')?.date).toBe('2026-11-13')
  })

  it('is null before the first round after it was set up', () => {
    const fresh = { ...fm, created: '2026-11-16T12:00:00Z' }
    expect(currentRound(fresh, new Date('2026-11-16T13:00:00Z'), 'America/New_York')).toBeNull()
  })
})

describe('summaries', () => {
  it('the deadline is 5 PM, or two hours after a late question', () => {
    expect(summaryDeadline(fm, '2026-11-16').toISOString()).toBe('2026-11-16T22:00:00.000Z')
    expect(summaryDeadline({ ...fm, time: '16:00' }, '2026-11-16').toISOString()).toBe(
      '2026-11-16T23:00:00.000Z',
    )
  })

  it('recent rounds look back three days in the check-in’s zone', () => {
    const rounds = recentRounds(fm, new Date('2026-11-16T15:00:00Z')).map((r) => r.date)
    expect(rounds).toEqual(['2026-11-16', '2026-11-13'])
  })
})
