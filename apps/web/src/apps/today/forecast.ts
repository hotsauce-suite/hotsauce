// The upcoming forecast in the weather menu (plan docs/PLAN-weather-forecast.md, F2–F5): the next
// 12 hours in 3-hour steps and the next 7 days, worked out from the server's MET Norway series.

import type { ForecastPoint } from '../../api/today'

const HOUR = 3_600_000

export interface ForecastHour {
  time: Date
  temperature: number
  symbol: string
}

export interface ForecastDay {
  /** `YYYY-MM-DD` in the device's time zone. */
  key: string
  /** Noon that day, for labels. */
  date: Date
  today: boolean
  /** Today, with only its evening left (from 6 PM on). */
  tonight: boolean
  high: number
  low: number
  symbol: string
  /** Rain or snow (water equivalent) over the part of the day the forecast covers, in mm. */
  precipitation: number
}

/** F2: the series' first point (the current hour), then every 3 hours up to 12 hours on. */
export function forecastHours(series: ForecastPoint[], steps = 4): ForecastHour[] {
  const first = series[0]
  if (!first) return []
  const start = Date.parse(first.time)
  const out: ForecastHour[] = []
  for (let k = 0; k <= steps; k++) {
    const target = start + k * 3 * HOUR
    const p = series.find((s) => Math.abs(Date.parse(s.time) - target) <= HOUR / 2)
    if (p) out.push({ time: new Date(p.time), temperature: p.temperature, symbol: p.symbol })
  }
  return out
}

function dayParts(ms: number, timeZone?: string): { key: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { key: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

/**
 * F3, F5: today and the days after, in the device's time zone (or `timeZone`), as far as the
 * series reaches. A day's icon is the symbol nearest its late morning (its wettest period's on a wet
 * day), shown as a day icon.
 */
export function forecastDays(
  series: ForecastPoint[],
  now: Date,
  days = 7,
  timeZone?: string,
): ForecastDay[] {
  const todayKey = dayParts(now.getTime(), timeZone).key
  const groups = new Map<string, Array<{ p: ForecastPoint; hour: number; ms: number }>>()
  for (const p of series) {
    const ms = Date.parse(p.time)
    const { key, hour } = dayParts(ms, timeZone)
    if (key < todayKey) continue
    const group = groups.get(key) ?? []
    group.push({ p, hour, ms })
    groups.set(key, group)
  }
  const out: ForecastDay[] = []
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b)).slice(0, days)) {
    const temps = group.map((g) => g.p.temperature)
    const pick = group.reduce((best, g) =>
      Math.abs(g.hour - 10) < Math.abs(best.hour - 10) ? g : best,
    )
    const today = key === todayKey
    const precipitation = group.reduce((sum, g) => sum + g.p.precipitation, 0)
    // A wet day shows its wettest period's icon, so the icon agrees with the rain amount (F4).
    const wettest = group.reduce((a, g) => (g.p.precipitation > a.p.precipitation ? g : a))
    const shown = precipitation > 1 ? wettest : pick
    out.push({
      key,
      date: new Date(pick.ms - (pick.hour - 12) * HOUR),
      today,
      tonight: today && group.every((g) => g.hour >= 18),
      high: Math.max(...temps),
      low: Math.min(...temps),
      symbol: today ? shown.p.symbol : shown.p.symbol.replace(/_night$/, '_day'),
      precipitation: Math.round(precipitation * 10) / 10,
    })
  }
  return out
}

/** F4: a day's rain or snow when it's more than a trace (1 mm), else null. */
export function rainLabel(mm: number, fahrenheit: boolean): string | null {
  if (!(mm > 1)) return null
  if (fahrenheit) return `💧 ${Math.max(0.1, Math.round((mm / 25.4) * 10) / 10).toFixed(1)} in`
  return `💧 ${Math.round(mm)} mm`
}
