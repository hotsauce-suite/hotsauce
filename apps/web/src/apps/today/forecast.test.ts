import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ForecastPoint } from '../../api/today'
import { forecastDays, forecastHours, rainLabel } from './forecast'

// Plan docs/PLAN-weather-forecast.md, F2–F5.

const START = Date.parse('2026-11-17T04:00:00Z') // 11 PM in Toronto
const TZ = 'America/Toronto'

/** MET's shape: hourly for 60 hours, then every 6 hours to about 9 days. */
function series(temp: (i: number) => number = () => 5, rain = 0): ForecastPoint[] {
  const times: number[] = []
  for (let h = 0; h < 60; h++) times.push(START + h * 3_600_000)
  for (let t = START + 62 * 3_600_000; t < START + 220 * 3_600_000; t += 6 * 3_600_000)
    times.push(t)
  return times.map((t, i) => ({
    time: new Date(t).toISOString(),
    temperature: temp(i),
    symbol: i % 2 ? 'cloudy' : 'partlycloudy_night',
    precipitation: rain,
  }))
}

describe('forecastHours (F2)', () => {
  it('gives now and every 3 hours up to 12 hours', () => {
    const hours = forecastHours(series((i) => i))
    expect(hours.map((h) => h.temperature)).toEqual([0, 3, 6, 9, 12])
    expect(hours[1]?.time.toISOString()).toBe('2026-11-17T07:00:00.000Z')
  })

  it('leaves out hours the forecast does not reach (F5)', () => {
    expect(forecastHours(series().slice(0, 4)).length).toBe(2)
    expect(forecastHours([])).toEqual([])
  })
})

describe('forecastDays (F3)', () => {
  it('gives today and the six days after, in the device time zone', () => {
    const days = forecastDays(series(), new Date(START), 7, TZ)
    expect(days.map((d) => d.key)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ])
    expect(days[0]).toMatchObject({ today: true, tonight: true })
    expect(days[1]?.tonight).toBe(false)
    expect(days.slice(1).every((d) => !d.today && !d.symbol.endsWith('_night'))).toBe(true)
  })

  it('takes each day’s high and low from its own points', () => {
    const s = series((i) => i)
    const days = forecastDays(s, new Date(START), 7, TZ)
    // Today (Nov 16 in Toronto) is only the 11 PM point.
    expect(days[0]).toMatchObject({ high: 0, low: 0 })
    // Nov 17 runs from 00:00 to 23:00 local, points 1 to 24.
    expect(days[1]).toMatchObject({ high: 24, low: 1 })
  })

  it('never shows a day outside the series, and high ≥ low', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: -40, max: 40, noNaN: true }), { minLength: 1, maxLength: 90 }),
        (temps) => {
          const s = series()
            .slice(0, temps.length)
            .map((p, i) => ({ ...p, temperature: temps[i] ?? 0 }))
          const days = forecastDays(s, new Date(START), 7, TZ)
          expect(days.length).toBeGreaterThan(0)
          expect(days.length).toBeLessThanOrEqual(7)
          for (const d of days) expect(d.high).toBeGreaterThanOrEqual(d.low)
        },
      ),
    )
  })

  it('adds up each day’s rain', () => {
    const days = forecastDays(
      series(() => 5, 0.5),
      new Date(START),
      7,
      TZ,
    )
    expect(days[1]?.precipitation).toBe(12)
    const wet = series().map((p, i) =>
      i === 20 ? { ...p, symbol: 'heavyrain', precipitation: 3 } : p,
    )
    expect(forecastDays(wet, new Date(START), 7, TZ)[1]?.symbol).toBe('heavyrain')
  })
})

describe('rainLabel (F4)', () => {
  it('stays quiet for a trace and shows inches or millimetres otherwise', () => {
    expect(rainLabel(0, true)).toBeNull()
    expect(rainLabel(1, false)).toBeNull()
    expect(rainLabel(10.2, true)).toBe('💧 0.4 in')
    expect(rainLabel(1.1, true)).toBe('💧 0.1 in')
    expect(rainLabel(6.4, false)).toBe('💧 6 mm')
  })
})
