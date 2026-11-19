import { describe, expect, it } from 'vitest'
import {
  BreakSettingsError,
  defaultBreakSettings,
  parseBreakSettings,
  readBreakSettings,
  serializeBreakSettings,
  withinWorkingHours,
} from './breaks.js'

describe('break settings (PLAN-breaks B1, B2)', () => {
  it('B1: the defaults are off, every 20 minutes for 20 seconds, breathing, chime, any time', () => {
    expect(defaultBreakSettings()).toEqual({
      schema: 1,
      on: false,
      everyMinutes: 20,
      lengthSeconds: 20,
      animation: 'breathe',
      chime: true,
      hours: null,
    })
  })

  it('B1: reading falls back per value for anything missing, unknown or out of range', () => {
    expect(readBreakSettings('not json')).toEqual(defaultBreakSettings())
    expect(readBreakSettings(null)).toEqual(defaultBreakSettings())
    expect(readBreakSettings([1])).toEqual(defaultBreakSettings())
    expect(
      readBreakSettings({
        on: true,
        everyMinutes: 2,
        lengthSeconds: 30,
        animation: 'fireworks',
        chime: 'yes',
        hours: { start: '25:00', end: '18:00', days: [1] },
      }),
    ).toEqual({ ...defaultBreakSettings(), on: true, lengthSeconds: 30 })
  })

  it('B1: a saved file reads back exactly', () => {
    const s = {
      ...defaultBreakSettings(),
      on: true,
      everyMinutes: 45,
      lengthSeconds: 300,
      animation: 'waves' as const,
      chime: false,
      hours: { start: '08:30', end: '17:00', days: [5, 1, 1, 3] },
    }
    const back = readBreakSettings(serializeBreakSettings(s))
    expect(back).toEqual({ ...s, hours: { start: '08:30', end: '17:00', days: [1, 3, 5] } })
  })

  it('B2: saving refuses wrong values, saying which', () => {
    const ok = { ...defaultBreakSettings(), on: true }
    expect(parseBreakSettings(ok)).toEqual(ok)
    expect(parseBreakSettings({ ...ok, schema: undefined })).toEqual(ok)
    const bad: unknown[] = [
      null,
      'x',
      { ...ok, extra: 1 },
      { ...ok, on: 'yes' },
      { ...ok, everyMinutes: 4 },
      { ...ok, everyMinutes: 20.5 },
      { ...ok, lengthSeconds: 901 },
      { ...ok, animation: 'fireworks' },
      { ...ok, chime: 1 },
      { ...ok, hours: { start: '09:00', end: '09:00', days: [1] } },
      { ...ok, hours: { start: '9:00', end: '17:00', days: [1] } },
      { ...ok, hours: { start: '09:00', end: '17:00', days: [7] } },
      { ...ok, hours: { start: '09:00', end: '17:00', days: [] } },
    ]
    for (const b of bad) expect(() => parseBreakSettings(b)).toThrow(BreakSettingsError)
  })
})

describe('working hours (B6)', () => {
  const weekdays = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }
  // 2026-11-19 is a Thursday, 2026-11-21 a Saturday.
  it('is inside between the times on the chosen days only', () => {
    expect(withinWorkingHours(null, new Date(2026, 10, 21, 3, 0))).toBe(true)
    expect(withinWorkingHours(weekdays, new Date(2026, 10, 19, 9, 0))).toBe(true)
    expect(withinWorkingHours(weekdays, new Date(2026, 10, 19, 17, 59))).toBe(true)
    expect(withinWorkingHours(weekdays, new Date(2026, 10, 19, 18, 0))).toBe(false)
    expect(withinWorkingHours(weekdays, new Date(2026, 10, 19, 8, 59))).toBe(false)
    expect(withinWorkingHours(weekdays, new Date(2026, 10, 21, 12, 0))).toBe(false)
  })

  it('hours across midnight belong to the day they start', () => {
    const nights = { start: '22:00', end: '06:00', days: [5] } // Friday nights
    expect(withinWorkingHours(nights, new Date(2026, 10, 20, 23, 0))).toBe(true) // Fri 23:00
    expect(withinWorkingHours(nights, new Date(2026, 10, 21, 5, 0))).toBe(true) // Sat 05:00
    expect(withinWorkingHours(nights, new Date(2026, 10, 21, 23, 0))).toBe(false) // Sat 23:00
    expect(withinWorkingHours(nights, new Date(2026, 10, 20, 12, 0))).toBe(false)
  })
})
