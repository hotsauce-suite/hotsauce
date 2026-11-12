import { describe, expect, it } from 'vitest'
import {
  BookingFrontmatter,
  type BookingRules,
  bookingPath,
  openSlots,
  zonedTimeToUtc,
} from './booking.js'

// Booking links (ARCHITECTURE §19, plan S1): which times a booker may pick, from the member's
// working hours and Google free/busy. Pure; every instant is UTC ISO.

const NINE_TO_FIVE: BookingRules['hours'] = {
  mon: [['09:00', '17:00']],
  tue: [['09:00', '17:00']],
  wed: [['09:00', '17:00']],
  thu: [['09:00', '17:00']],
  fri: [['09:00', '17:00']],
  sat: [],
  sun: [],
}

const rules = (o: Partial<BookingRules> = {}): BookingRules => ({
  minutes: 30,
  tz: 'America/New_York',
  hours: NINE_TO_FIVE,
  bufferBefore: 0,
  bufferAfter: 0,
  noticeMinutes: 0,
  horizonDays: 60,
  dailyCap: null,
  ...o,
})

const starts = (slots: Array<{ start: string }>) => slots.map((s) => s.start)

describe('zonedTimeToUtc', () => {
  it.each([
    ['2026-01-15', '09:00', 'America/New_York', '2026-01-15T14:00:00.000Z'],
    ['2026-07-15', '09:00', 'America/New_York', '2026-07-15T13:00:00.000Z'],
    ['2026-07-15', '09:00', 'Asia/Kolkata', '2026-07-15T03:30:00.000Z'],
    ['2026-07-15', '00:00', 'UTC', '2026-07-15T00:00:00.000Z'],
    // Fall back: 01:30 happens twice; the first (daylight) one.
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
  ])('%s %s in %s is %s', (date, time, tz, want) => {
    expect(zonedTimeToUtc(date, time, tz)?.toISOString()).toBe(want)
  })

  it('a time skipped by spring forward is null', () => {
    expect(zonedTimeToUtc('2026-03-08', '02:30', 'America/New_York')).toBeNull()
  })
})

describe('openSlots', () => {
  const monday = { from: '2026-01-12T05:00:00Z', to: '2026-01-13T05:00:00Z' } // Mon in New York
  const now = new Date('2026-01-01T00:00:00Z')

  it('splits working hours into slots of the length, in the member’s time zone', () => {
    const slots = openSlots(rules(), [], { now, ...monday })
    expect(slots).toHaveLength(16)
    expect(slots[0]).toEqual({ start: '2026-01-12T14:00:00.000Z', end: '2026-01-12T14:30:00.000Z' })
    expect(slots.at(-1)?.start).toBe('2026-01-12T21:30:00.000Z')
    // A 45-minute link fits 10 in eight hours; the last ends at 4:30.
    const long = openSlots(rules({ minutes: 45 }), [], { now, ...monday })
    expect(long).toHaveLength(10)
    expect(long.at(-1)?.end).toBe('2026-01-12T21:30:00.000Z')
  })

  it('no slots on a day off', () => {
    const saturday = { from: '2026-01-17T05:00:00Z', to: '2026-01-18T05:00:00Z' }
    expect(openSlots(rules(), [], { now, ...saturday })).toEqual([])
  })

  it('leaves out busy times, with buffers around them', () => {
    const busy = [{ start: '2026-01-12T15:00:00Z', end: '2026-01-12T16:00:00Z' }] // 10–11 NY
    const plain = starts(openSlots(rules(), busy, { now, ...monday }))
    expect(plain).not.toContain('2026-01-12T15:00:00.000Z')
    expect(plain).not.toContain('2026-01-12T15:30:00.000Z')
    expect(plain).toContain('2026-01-12T14:30:00.000Z')
    expect(plain).toContain('2026-01-12T16:00:00.000Z')
    // 15 minutes either side: 9:30 ends too close before, 11:00 starts too close after.
    const buffered = starts(
      openSlots(rules({ bufferBefore: 15, bufferAfter: 15 }), busy, { now, ...monday }),
    )
    expect(buffered).not.toContain('2026-01-12T14:30:00.000Z')
    expect(buffered).not.toContain('2026-01-12T16:00:00.000Z')
    expect(buffered).toContain('2026-01-12T14:00:00.000Z')
    expect(buffered).toContain('2026-01-12T16:30:00.000Z')
  })

  it('keeps minimum notice and the horizon', () => {
    const at = new Date('2026-01-12T15:10:00Z') // 10:10 NY on the Monday
    const soon = starts(openSlots(rules({ noticeMinutes: 60 }), [], { now: at, ...monday }))
    expect(soon[0]).toBe('2026-01-12T16:30:00.000Z') // 11:30, the first start an hour away
    const near = openSlots(rules({ horizonDays: 1 }), [], {
      now: new Date('2026-01-10T12:00:00Z'),
      from: '2026-01-10T00:00:00Z',
      to: '2026-01-20T00:00:00Z',
    })
    expect(near).toEqual([]) // Saturday now; Monday is beyond one day ahead
  })

  it('stops a day at its cap of bookings', () => {
    const booked = ['2026-01-12T14:00:00Z', '2026-01-12T20:00:00Z']
    expect(openSlots(rules({ dailyCap: 2 }), [], { now, ...monday, booked })).toEqual([])
    expect(openSlots(rules({ dailyCap: 3 }), [], { now, ...monday, booked })).toHaveLength(16)
  })

  it('across a DST change, nine o’clock stays nine o’clock local', () => {
    // Week of Sun 2026-03-08, when New York springs forward.
    const week = openSlots(rules({ minutes: 60, horizonDays: 365 }), [], {
      now,
      from: '2026-03-06T05:00:00Z',
      to: '2026-03-11T04:00:00Z',
    })
    const firstOfDay = new Map<string, string>()
    for (const s of week) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
        new Date(s.start),
      )
      if (!firstOfDay.has(day)) firstOfDay.set(day, s.start)
    }
    expect([...firstOfDay.entries()]).toEqual([
      ['2026-03-06', '2026-03-06T14:00:00.000Z'], // Friday, EST
      ['2026-03-09', '2026-03-09T13:00:00.000Z'], // Monday, EDT
      ['2026-03-10', '2026-03-10T13:00:00.000Z'],
    ])
  })

  it('working hours that cross the gap skip the missing hour', () => {
    const night = rules({
      minutes: 30,
      horizonDays: 365,
      hours: { ...NINE_TO_FIVE, sun: [['01:00', '04:00']] },
    })
    const slots = starts(
      openSlots(night, [], { now, from: '2026-03-08T05:00:00Z', to: '2026-03-09T04:00:00Z' }),
    )
    // 01:00, 01:30, (02:00, 02:30 don't exist), 03:00, 03:30 EDT.
    expect(slots).toEqual([
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T06:30:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T07:30:00.000Z',
    ])
  })

  it('only shows slots inside from..to', () => {
    const slots = openSlots(rules(), [], {
      now,
      from: '2026-01-12T16:00:00Z',
      to: '2026-01-12T17:00:00Z',
    })
    expect(starts(slots)).toEqual(['2026-01-12T16:00:00.000Z', '2026-01-12T16:30:00.000Z'])
  })
})

describe('the booking file', () => {
  it('parses with defaults and refuses bad values', () => {
    const fm = BookingFrontmatter.parse({ title: 'Intro call', minutes: 30, tz: 'Europe/London' })
    expect(fm).toMatchObject({
      minutes: 30,
      buffer_before: 0,
      notice_minutes: 240,
      horizon_days: 30,
      daily_cap: null,
      questions: [],
      active: true,
    })
    expect(fm.hours.mon).toEqual([['09:00', '17:00']])
    expect(fm.hours.sat).toEqual([])
    expect(BookingFrontmatter.safeParse({ title: 'x', minutes: 20, tz: 'UTC' }).success).toBe(false)
    expect(BookingFrontmatter.safeParse({ title: 'x', minutes: 30, tz: 'Mars/Base' }).success).toBe(
      false,
    )
    expect(
      BookingFrontmatter.safeParse({
        title: 'x',
        minutes: 30,
        tz: 'UTC',
        hours: { mon: [['17:00', '09:00']] },
      }).success,
    ).toBe(false)
    expect(
      BookingFrontmatter.safeParse({
        title: 'x',
        minutes: 30,
        tz: 'UTC',
        questions: ['a', 'b', 'c', 'd'],
      }).success,
    ).toBe(false)
    expect(bookingPath('intro-call')).toBe('.hearth/booking/intro-call.md')
    expect(() => bookingPath('../x')).toThrow()
  })
})
