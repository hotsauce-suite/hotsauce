import { describe, expect, it } from 'vitest'
import { scheduleLabel } from './checkins.js'

describe('scheduleLabel (W7)', () => {
  it('lists days Monday first, whatever order they were picked in', () => {
    expect(scheduleLabel(['fri', 'mon', 'wed'], '09:00')).toBe('Mon, Wed and Fri at 9 AM')
    expect(scheduleLabel(['sun', 'mon'], '09:00')).toBe('Mon and Sun at 9 AM')
  })

  it('names one day, weekdays and every day', () => {
    expect(scheduleLabel(['mon'], '09:00')).toBe('Mondays at 9 AM')
    expect(scheduleLabel(['fri', 'thu', 'wed', 'tue', 'mon'], '09:00')).toBe(
      'Every weekday at 9 AM',
    )
    expect(scheduleLabel(['sun', 'sat', 'fri', 'thu', 'wed', 'tue', 'mon'], '09:00')).toBe(
      'Every day at 9 AM',
    )
  })
})
