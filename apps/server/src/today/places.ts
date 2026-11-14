// A typed city becomes a place for the Today header's weather (ARCHITECTURE §16.5), through
// Open-Meteo's free geocoding API (https://open-meteo.com/en/docs/geocoding-api, no key; data from
// GeoNames, CC BY 4.0). Only the typed name is sent. Positions are rounded like a shared location.

import { HearthError } from '../errors.js'
import { roundPlace } from './weather.js'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
export const PLACES_TTL_MS = 24 * 3_600_000
const MAX_QUERIES = 500
/** Uncached searches per member per minute: typing a name searches as it goes. */
export const PLACE_SEARCHES_PER_MINUTE = 20

export interface PlaceView {
  name: string
  /** Region and country, e.g. "Vermont, United States". */
  detail: string
  lat: number
  lon: number
}

export interface PlacesDeps {
  fetch?: typeof fetch
  now?: () => number
  version?: string
}

interface GeocodingResponse {
  results?: Array<{
    name?: string
    latitude?: number
    longitude?: number
    admin1?: string
    country?: string
  }>
}

export class Places {
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #agent: string
  readonly #cache = new Map<string, { at: number; places: PlaceView[] }>()
  readonly #searches = new Map<string, number[]>()

  constructor(deps: PlacesDeps = {}) {
    this.#fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#now = deps.now ?? Date.now
    this.#agent = `Hotsauce/${deps.version ?? 'dev'} https://hotsauce.work`
  }

  /** Up to five places named like `query`. `who` is the member asking; their misses are limited. */
  async search(query: string, who = ''): Promise<PlaceView[]> {
    const name = query.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (name.length < 2) return []
    const key = name.toLowerCase()
    const now = this.#now()
    const hit = this.#cache.get(key)
    if (hit && now - hit.at < PLACES_TTL_MS) return hit.places

    const recent = (this.#searches.get(who) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= PLACE_SEARCHES_PER_MINUTE) {
      throw new HearthError('rate_limited', 'Too many place searches. Try again in a minute.')
    }
    recent.push(now)
    this.#searches.set(who, recent)
    if (this.#searches.size > MAX_QUERIES) this.#searches.clear()

    let body: GeocodingResponse
    try {
      const url = new URL(GEOCODING_URL)
      url.searchParams.set('name', name)
      url.searchParams.set('count', '5')
      url.searchParams.set('language', 'en')
      url.searchParams.set('format', 'json')
      const res = await this.#fetch(url.toString(), {
        headers: { 'User-Agent': this.#agent, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`)
      body = (await res.json()) as GeocodingResponse
    } catch {
      if (hit) return hit.places
      throw new HearthError('host_error', 'The place search didn’t answer. Try again later.')
    }
    const places = (body.results ?? []).flatMap((r): PlaceView[] => {
      if (!r.name || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return []
      const { lat, lon } = roundPlace(r.latitude, r.longitude)
      const detail = [r.admin1, r.country].filter((s) => s && s !== r.name).join(', ')
      return [{ name: r.name, detail, lat, lon }]
    })
    this.#cache.delete(key)
    if (this.#cache.size >= MAX_QUERIES) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    this.#cache.set(key, { at: now, places })
    return places
  }
}
