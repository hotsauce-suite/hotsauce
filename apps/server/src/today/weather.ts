// Weather for the Today header (ARCHITECTURE §16.5), from MET Norway's free Locationforecast API
// (https://api.met.no/doc/TermsOfService): an identifying User-Agent, at most 4 decimals of
// position, and cached answers. We round to 2 decimals (about 1 km) and keep each place 20 min.

import { HearthError } from '../errors.js'

export const WEATHER_TTL_MS = 20 * 60_000
const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
const MAX_PLACES = 500

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
        next_1_hours?: { summary?: { symbol_code?: string } }
        next_6_hours?: { summary?: { symbol_code?: string } }
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
  readonly #cache = new Map<string, { at: number; view: WeatherView }>()

  constructor(deps: WeatherDeps = {}) {
    // Looked up per call, so a test's stub of the global fetch applies.
    this.#fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#now = deps.now ?? Date.now
    this.#agent = `Hotsauce/${deps.version ?? 'dev'} https://hotsauce.work`
  }

  async forecast(lat: number, lon: number): Promise<WeatherView> {
    const place = roundPlace(lat, lon)
    const key = `${place.lat},${place.lon}`
    const hit = this.#cache.get(key)
    if (hit && this.#now() - hit.at < WEATHER_TTL_MS) return hit.view

    let body: MetResponse
    try {
      const res = await this.#fetch(`${MET_URL}?lat=${place.lat}&lon=${place.lon}`, {
        headers: { 'User-Agent': this.#agent, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`MET answered ${res.status}`)
      body = (await res.json()) as MetResponse
    } catch {
      // A stale answer beats none.
      if (hit) return hit.view
      throw new HearthError('host_error', 'The weather service didn’t answer. Try again later.')
    }
    const view = summarize(body, this.#now())
    if (!view) {
      if (hit) return hit.view
      throw new HearthError('host_error', 'The weather service sent something unexpected.')
    }
    if (this.#cache.size >= MAX_PLACES) this.#cache.clear()
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
  }
}
