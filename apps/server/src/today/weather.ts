// Weather for the Today header (ARCHITECTURE §16.5), from MET Norway's free Locationforecast API
// (https://api.met.no/doc/TermsOfService): an identifying User-Agent, at most 4 decimals of
// position, and cached answers. We round to 2 decimals (about 1 km) and keep each place 20 min.

import { HotsauceError } from '../errors.js'

export const WEATHER_TTL_MS = 20 * 60_000
const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
const MAX_PLACES = 500
/** A place MET just failed for isn't asked again this soon. */
export const WEATHER_FAILURE_TTL_MS = 60_000
/** Places not already cached, per member per minute: MET throttles by User-Agent, so one member
 * looping over coordinates could otherwise get weather blocked for the whole instance. */
export const WEATHER_MISSES_PER_MINUTE = 10

export interface WeatherView {
  /** Now, in °C. */
  temperature: number
  /** MET's symbol code for the next hour, e.g. `partlycloudy_day`. */
  symbol: string
  /** Over the next 24 hours, in °C. */
  high: number
  low: number
  /** When MET made the forecast. */
  updated: string
  /** MET's terms ask for credit. */
  credit: 'MET Norway'
  /** The forecast from the current hour on: hourly for about 2½ days, then every 6 hours. */
  series: ForecastPoint[]
}

export interface ForecastPoint {
  time: string
  /** At `time`, in °C. */
  temperature: number
  /** MET's symbol code for the period until the next point. */
  symbol: string
  /** Rain or snow (water equivalent), in mm, over the period until the next point. */
  precipitation: number
}

export interface WeatherDeps {
  fetch?: typeof fetch
  now?: () => number
  version?: string
}

interface MetResponse {
  properties?: {
    meta?: { updated_at?: string }
    timeseries?: Array<{
      time: string
      data?: {
        instant?: { details?: { air_temperature?: number } }
        next_1_hours?: {
          summary?: { symbol_code?: string }
          details?: { precipitation_amount?: number }
        }
        next_6_hours?: {
          summary?: { symbol_code?: string }
          details?: { precipitation_amount?: number }
        }
      }
    }>
  }
}

export function roundPlace(lat: number, lon: number): { lat: number; lon: number } {
  const r = (n: number) => Math.round(n * 100) / 100
  return { lat: r(lat), lon: r(lon) }
}

export class Weather {
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #agent: string
  /** Oldest first: a hit moves to the end, and a full cache drops from the front. */
  readonly #cache = new Map<string, { at: number; view: WeatherView }>()
  readonly #failed = new Map<string, number>()
  readonly #misses = new Map<string, number[]>()

  constructor(deps: WeatherDeps = {}) {
    // Looked up per call, so a test's stub of the global fetch applies.
    this.#fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#now = deps.now ?? Date.now
    this.#agent = `Hotsauce/${deps.version ?? 'dev'} https://hotsauce.work`
  }

  /** `who` is the member asking; their cache misses are rate limited. */
  async forecast(lat: number, lon: number, who = ''): Promise<WeatherView> {
    const place = roundPlace(lat, lon)
    const key = `${place.lat},${place.lon}`
    const now = this.#now()
    const hit = this.#cache.get(key)
    if (hit) {
      this.#cache.delete(key)
      this.#cache.set(key, hit)
      if (now - hit.at < WEATHER_TTL_MS) return hit.view
    }
    const failedAt = this.#failed.get(key)
    if (failedAt !== undefined && now - failedAt < WEATHER_FAILURE_TTL_MS) {
      if (hit) return hit.view
      throw new HotsauceError('host_error', 'The weather service didn’t answer. Try again later.')
    }
    const recent = (this.#misses.get(who) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= WEATHER_MISSES_PER_MINUTE) {
      if (hit) return hit.view
      throw new HotsauceError('rate_limited', 'Too many weather lookups. Try again in a minute.')
    }
    recent.push(now)
    this.#misses.set(who, recent)
    if (this.#misses.size > MAX_PLACES) this.#misses.clear()

    let body: MetResponse
    try {
      const res = await this.#fetch(`${MET_URL}?lat=${place.lat}&lon=${place.lon}`, {
        headers: { 'User-Agent': this.#agent, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`MET answered ${res.status}`)
      body = (await res.json()) as MetResponse
    } catch {
      this.#failed.set(key, this.#now())
      if (this.#failed.size > MAX_PLACES) this.#failed.clear()
      // A stale answer beats none.
      if (hit) return hit.view
      throw new HotsauceError('host_error', 'The weather service didn’t answer. Try again later.')
    }
    const view = summarize(body, this.#now())
    if (!view) {
      if (hit) return hit.view
      throw new HotsauceError('host_error', 'The weather service sent something unexpected.')
    }
    this.#failed.delete(key)
    this.#cache.delete(key)
    if (this.#cache.size >= MAX_PLACES) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    this.#cache.set(key, { at: this.#now(), view })
    return view
  }
}

/** The current hour, plus the high and low over the next 24 hours. */
export function summarize(body: MetResponse, now: number): WeatherView | null {
  const series = body.properties?.timeseries ?? []
  const upcoming = series.filter((s) => Date.parse(s.time) > now - 3_600_000)
  const first = upcoming[0]
  const temperature = first?.data?.instant?.details?.air_temperature
  if (!first || typeof temperature !== 'number') return null
  const day = upcoming
    .filter((s) => Date.parse(s.time) <= now + 86_400_000)
    .map((s) => s.data?.instant?.details?.air_temperature)
    .filter((t): t is number => typeof t === 'number')
  return {
    temperature,
    symbol:
      first.data?.next_1_hours?.summary?.symbol_code ??
      first.data?.next_6_hours?.summary?.symbol_code ??
      'cloudy',
    high: Math.max(...day),
    low: Math.min(...day),
    updated: body.properties?.meta?.updated_at ?? first.time,
    credit: 'MET Norway',
    series: toSeries(upcoming),
  }
}

type MetPoint = NonNullable<NonNullable<MetResponse['properties']>['timeseries']>[number]

/**
 * Each point's symbol and precipitation cover the time until the next point: MET's 1-hour figures
 * while points are hourly, its 6-hour figures after, so a day's total counts each hour once.
 */
export function toSeries(all: MetPoint[]): ForecastPoint[] {
  // A point without a temperature is dropped first, so the one before it covers its time.
  const points = all.filter((p) => typeof p.data?.instant?.details?.air_temperature === 'number')
  const out: ForecastPoint[] = []
  points.forEach((p, i) => {
    const temperature = p.data?.instant?.details?.air_temperature ?? 0
    const next = points[i + 1]
    const gapHours = next ? (Date.parse(next.time) - Date.parse(p.time)) / 3_600_000 : 6
    const one = p.data?.next_1_hours
    const six = p.data?.next_6_hours
    const period = gapHours <= 1 && one ? one : (six ?? one)
    const amount = period?.details?.precipitation_amount
    let precipitation = typeof amount === 'number' ? amount : 0
    // A 6-hour figure over a shorter step (rare, where MET changes step) counts only its share.
    if (period === six && six && gapHours < 6) precipitation = (precipitation * gapHours) / 6
    out.push({
      time: p.time,
      temperature,
      symbol: period?.summary?.symbol_code ?? 'cloudy',
      precipitation: Math.round(precipitation * 100) / 100,
    })
  })
  return out
}
