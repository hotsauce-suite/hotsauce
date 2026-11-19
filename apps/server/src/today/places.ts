// A typed city becomes a place for the Today header's weather (ARCHITECTURE §16.5), through
// Open-Meteo's free geocoding API (https://open-meteo.com/en/docs/geocoding-api, no key; data from
// GeoNames, CC BY 4.0). Only the typed name is sent. Positions are rounded like a shared location.
// A shared location gets its name the other way round, from OpenStreetMap's Nominatim
// (https://nominatim.org/release-docs/latest/api/Reverse/, no key; data © OpenStreetMap
// contributors, ODbL). Only the rounded position is sent, at most one request a second, cached.

import { HotsauceError } from '../errors.js'
import { roundPlace } from './weather.js'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse'
/** Places don't move: a position's name is kept for a month. */
export const PLACE_NAME_TTL_MS = 30 * 24 * 3_600_000
/** Uncached lookups per member per minute. */
export const PLACE_NAMES_PER_MINUTE = 10
/** Nominatim's usage policy: at most one request a second from the whole server. */
const REVERSE_GAP_MS = 1_100
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
  /** Waits between Nominatim requests (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>
}

interface ReverseResponse {
  name?: string
  address?: Record<string, string | undefined>
}

/** The place a position is in: a city, town or village, else the nearest named area. */
function nameOf(body: ReverseResponse): { name: string; detail: string } | null {
  const a = body.address ?? {}
  const name =
    a.city ??
    a.town ??
    a.village ??
    a.hamlet ??
    a.municipality ??
    a.suburb ??
    a.county ??
    body.name ??
    a.state
  if (!name) return null
  const detail = [a.state, a.country].filter((s) => s && s !== name).join(', ')
  return { name: name.slice(0, 80), detail: detail.slice(0, 120) }
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
  readonly #names = new Map<string, { at: number; place: PlaceView | null }>()
  readonly #lookups = new Map<string, number[]>()
  #lastReverse: Promise<unknown> = Promise.resolve()
  readonly #wait: (ms: number) => Promise<void>

  constructor(deps: PlacesDeps = {}) {
    this.#fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#now = deps.now ?? Date.now
    this.#agent = `Hotsauce/${deps.version ?? 'dev'} https://hotsauce.work`
    this.#wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * The named place a position is in (rounded to about 1 km first), or null when it's nowhere
   * named (the open sea). `who` is the member asking; their misses are limited.
   */
  async at(lat: number, lon: number, who = ''): Promise<PlaceView | null> {
    const pos = roundPlace(lat, lon)
    const key = `${pos.lat},${pos.lon}`
    const now = this.#now()
    const hit = this.#names.get(key)
    if (hit && now - hit.at < PLACE_NAME_TTL_MS) return hit.place

    const recent = (this.#lookups.get(who) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= PLACE_NAMES_PER_MINUTE) {
      throw new HotsauceError('rate_limited', 'Too many place lookups. Try again in a minute.')
    }
    recent.push(now)
    this.#lookups.set(who, recent)
    if (this.#lookups.size > MAX_QUERIES) this.#lookups.clear()

    // One request at a time, a second apart, from the whole server.
    const turn = this.#lastReverse.then(() => this.#reverse(pos.lat, pos.lon))
    this.#lastReverse = turn.then(
      () => this.#wait(REVERSE_GAP_MS),
      () => this.#wait(REVERSE_GAP_MS),
    )
    let named: { name: string; detail: string } | null
    try {
      named = await turn
    } catch {
      if (hit) return hit.place
      throw new HotsauceError('host_error', 'The place lookup didn’t answer. Try again later.')
    }
    const place = named ? { ...named, ...pos } : null
    this.#names.delete(key)
    if (this.#names.size >= MAX_QUERIES) {
      const oldest = this.#names.keys().next().value
      if (oldest !== undefined) this.#names.delete(oldest)
    }
    this.#names.set(key, { at: now, place })
    return place
  }

  async #reverse(lat: number, lon: number): Promise<{ name: string; detail: string } | null> {
    const url = new URL(REVERSE_URL)
    url.searchParams.set('lat', String(lat))
    url.searchParams.set('lon', String(lon))
    url.searchParams.set('zoom', '10')
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('accept-language', 'en')
    const res = await this.#fetch(url.toString(), {
      headers: { 'User-Agent': this.#agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) throw new Error(`Nominatim answered ${res.status}`)
    return nameOf((await res.json()) as ReverseResponse)
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
      throw new HotsauceError('rate_limited', 'Too many place searches. Try again in a minute.')
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
      throw new HotsauceError('host_error', 'The place search didn’t answer. Try again later.')
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
