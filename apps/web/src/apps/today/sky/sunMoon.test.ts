import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { moonPhase, skyPhase, sunProgress, sunTimes } from './sunMoon'

const MONTPELIER = { lat: 44.26, lon: -72.58 }
const minutesUtc = (d: Date | null) => (d ? d.getUTCHours() * 60 + d.getUTCMinutes() : null)

describe('sunTimes', () => {
  it('matches published sunrise and sunset for Montpelier, VT on 2026-11-19 within 3 minutes', () => {
    // NOAA: sunrise 6:53 EST (11:53Z), sunset 16:20 EST (21:20Z).
    const t = sunTimes(new Date('2026-11-19T17:00:00Z'), MONTPELIER)
    expect(t.kind).toBe('normal')
    if (t.kind !== 'normal') return
    expect(Math.abs((minutesUtc(t.sunrise) ?? 0) - (11 * 60 + 53))).toBeLessThanOrEqual(3)
    expect(Math.abs((minutesUtc(t.sunset) ?? 0) - (21 * 60 + 20))).toBeLessThanOrEqual(3)
  })

  it('matches London on the June solstice within 3 minutes', () => {
    // 04:43 BST (03:43Z) and 21:21 BST (20:21Z).
    const t = sunTimes(new Date('2026-06-21T12:00:00Z'), { lat: 51.5, lon: -0.12 })
    if (t.kind !== 'normal') throw new Error(t.kind)
    expect(Math.abs((minutesUtc(t.sunrise) ?? 0) - (3 * 60 + 43))).toBeLessThanOrEqual(3)
    expect(Math.abs((minutesUtc(t.sunset) ?? 0) - (20 * 60 + 21))).toBeLessThanOrEqual(3)
  })

  it('knows the midnight sun and the polar night', () => {
    expect(sunTimes(new Date('2026-06-21T12:00:00Z'), { lat: 78.2, lon: 15.6 }).kind).toBe(
      'alwaysUp',
    )
    expect(sunTimes(new Date('2026-12-21T12:00:00Z'), { lat: 78.2, lon: 15.6 }).kind).toBe(
      'alwaysDown',
    )
  })

  it('always puts sunrise before sunset, about 12 hours apart at the equator', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2035-01-01'), noInvalidDate: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        (date, lat, lon) => {
          const t = sunTimes(date, { lat, lon })
          if (t.kind !== 'normal') return
          expect(t.sunrise.getTime()).toBeLessThan(t.sunset.getTime())
          const hours = (t.sunset.getTime() - t.sunrise.getTime()) / 3_600_000
          expect(hours).toBeGreaterThan(5)
          expect(hours).toBeLessThan(19)
          if (Math.abs(lat) < 1) expect(Math.abs(hours - 12.1)).toBeLessThan(0.3)
        },
      ),
    )
  })
})

describe('sunProgress', () => {
  it('is 0 at sunrise, 0.5 at midday, 1 at sunset, and null at night', () => {
    const sunrise = new Date('2026-11-19T12:00:00Z')
    const sunset = new Date('2026-11-19T22:00:00Z')
    const t = { kind: 'normal' as const, sunrise, sunset }
    expect(sunProgress(sunrise, t)).toBe(0)
    expect(sunProgress(new Date('2026-11-19T17:00:00Z'), t)).toBe(0.5)
    expect(sunProgress(sunset, t)).toBe(1)
    expect(sunProgress(new Date('2026-11-19T23:00:00Z'), t)).toBeNull()
  })
})

describe('skyPhase', () => {
  const t = sunTimes(new Date('2026-11-19T17:00:00Z'), MONTPELIER)
  it('names the time of day from the sun', () => {
    expect(skyPhase(new Date('2026-11-19T17:00:00Z'), t)).toBe('day')
    expect(skyPhase(new Date('2026-11-19T11:45:00Z'), t)).toBe('dawn')
    expect(skyPhase(new Date('2026-11-19T21:30:00Z'), t)).toBe('dusk')
    expect(skyPhase(new Date('2026-11-20T03:00:00Z'), t)).toBe('night')
  })
  it('follows the clock when there is no place', () => {
    const at = (h: number) => {
      const d = new Date(2026, 10, 19, h, 0)
      return skyPhase(d, null)
    }
    expect(at(12)).toBe('day')
    expect(at(6)).toBe('dawn')
    expect(at(18)).toBe('dusk')
    expect(at(23)).toBe('night')
  })
})

describe('moonPhase', () => {
  it('knows full and new moons', () => {
    // Full moon 2026-11-24 14:53Z; new moon 2026-11-09 07:02Z.
    expect(moonPhase(new Date('2026-11-24T15:00:00Z')).name).toBe('Full moon')
    expect(moonPhase(new Date('2026-11-09T07:00:00Z')).name).toBe('New moon')
    expect(moonPhase(new Date('2026-11-17T12:00:00Z')).name).toBe('First quarter')
  })
  it('keeps the lit fraction between 0 and 1', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2050-01-01'), noInvalidDate: true }),
        (d) => {
          const p = moonPhase(d)
          expect(p.illumination).toBeGreaterThanOrEqual(0)
          expect(p.illumination).toBeLessThanOrEqual(1)
          expect(p.age).toBeGreaterThanOrEqual(0)
          expect(p.age).toBeLessThan(1)
        },
      ),
    )
  })
})
