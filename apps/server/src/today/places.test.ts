import { describe, expect, it, vi } from 'vitest'
import { HotsauceError } from '../errors.js'
import { PLACE_SEARCHES_PER_MINUTE, PLACES_TTL_MS, Places } from './places.js'

// W5: a typed city becomes a place, through Open-Meteo's geocoding API.

const NOW = Date.parse('2026-11-14T03:00:00Z')

const BURLINGTON = {
  results: [
    {
      name: 'Burlington',
      latitude: 44.47588,
      longitude: -73.21207,
      admin1: 'Vermont',
      country: 'United States',
      country_code: 'US',
    },
    {
      name: 'Burlington',
      latitude: 43.32,
      longitude: -79.79,
      admin1: 'Ontario',
      country: 'Canada',
    },
    { name: 'Nowhere', country: 'Atlantis' },
  ],
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  )
}

describe('Places', () => {
  it('asks with the name only and answers rounded places with their region and country', async () => {
    const fetch = fakeFetch(BURLINGTON)
    const places = new Places({ fetch, now: () => NOW, version: '0.12.0' })
    const found = await places.search('  Burlington ')
    expect(found).toEqual([
      { name: 'Burlington', detail: 'Vermont, United States', lat: 44.48, lon: -73.21 },
      { name: 'Burlington', detail: 'Ontario, Canada', lat: 43.32, lon: -79.79 },
    ])
    const [url, init] = fetch.mock.calls[0] ?? []
    const asked = new URL(String(url))
    expect(asked.hostname).toBe('geocoding-api.open-meteo.com')
    expect(asked.searchParams.get('name')).toBe('Burlington')
    expect(asked.searchParams.get('count')).toBe('5')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['User-Agent']).toBe('Hotsauce/0.12.0 https://hotsauce.work')
  })

  it('answers short or empty queries with nothing, without asking', async () => {
    const fetch = fakeFetch(BURLINGTON)
    const places = new Places({ fetch, now: () => NOW })
    expect(await places.search(' a ')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caches each query for a day, whatever its case', async () => {
    let now = NOW
    const fetch = fakeFetch(BURLINGTON)
    const places = new Places({ fetch, now: () => now })
    await places.search('Burlington')
    await places.search('burlington')
    expect(fetch).toHaveBeenCalledTimes(1)
    now += PLACES_TTL_MS + 1
    await places.search('Burlington')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('answers no results as an empty list', async () => {
    const places = new Places({ fetch: fakeFetch({ generationtime_ms: 1 }), now: () => NOW })
    expect(await places.search('Zzyzxq')).toEqual([])
  })

  it('says so plainly when Open-Meteo fails', async () => {
    const places = new Places({ fetch: fakeFetch({}, 500), now: () => NOW })
    await expect(places.search('Burlington')).rejects.toMatchObject({
      code: 'host_error',
      message: 'The place search didn’t answer. Try again later.',
    })
  })

  it('limits each member’s uncached searches', async () => {
    const fetch = fakeFetch(BURLINGTON)
    const places = new Places({ fetch, now: () => NOW })
    for (let i = 0; i < PLACE_SEARCHES_PER_MINUTE; i++) await places.search(`City ${i}`, 'a@x')
    await expect(places.search('One more', 'a@x')).rejects.toBeInstanceOf(HotsauceError)
    // Someone else, and a cached query, still work.
    await places.search('One more', 'b@x')
    await places.search('City 1', 'a@x')
  })
})

// A shared location gets its name from OpenStreetMap's Nominatim (Settings → Weather).
const REVERSE = {
  name: 'Burlington',
  address: {
    city: 'Burlington',
    county: 'Chittenden County',
    state: 'Vermont',
    country: 'United States',
  },
}

describe('Places.at', () => {
  const noWait = async () => {}

  it('names a rounded position with its city, region and country', async () => {
    const fetch = fakeFetch(REVERSE)
    const places = new Places({ fetch, now: () => NOW, version: '0.52.0', wait: noWait })
    expect(await places.at(44.47612, -73.21291)).toEqual({
      name: 'Burlington',
      detail: 'Vermont, United States',
      lat: 44.48,
      lon: -73.21,
    })
    const [url, init] = fetch.mock.calls[0] ?? []
    const asked = new URL(String(url))
    expect(asked.hostname).toBe('nominatim.openstreetmap.org')
    expect(asked.searchParams.get('lat')).toBe('44.48')
    expect(asked.searchParams.get('lon')).toBe('-73.21')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['User-Agent']).toBe('Hotsauce/0.52.0 https://hotsauce.work')
  })

  it('falls back to a town or village, and answers null where nothing is named', async () => {
    const town = new Places({
      fetch: fakeFetch({ address: { town: 'Stowe', state: 'Vermont', country: 'United States' } }),
      now: () => NOW,
      wait: noWait,
    })
    expect((await town.at(44.46, -72.69))?.name).toBe('Stowe')
    const sea = new Places({
      fetch: fakeFetch({ error: 'Unable to geocode' }),
      now: () => NOW,
      wait: noWait,
    })
    expect(await sea.at(0, -30)).toBeNull()
  })

  it('asks once for the same spot, and keeps answering it when Nominatim is down', async () => {
    let now = NOW
    const fetch = fakeFetch(REVERSE)
    const places = new Places({ fetch, now: () => now, wait: noWait })
    await places.at(44.476, -73.212)
    await places.at(44.479, -73.209)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 31 * 24 * 3_600_000
    fetch.mockImplementation(async () => Response.json({}, { status: 503 }))
    expect((await places.at(44.476, -73.212))?.name).toBe('Burlington')
  })

  it('limits one member’s lookups', async () => {
    const places = new Places({ fetch: fakeFetch(REVERSE), now: () => NOW, wait: noWait })
    for (let i = 0; i < 10; i++) await places.at(40 + i, -70, 'a@x.com')
    await expect(places.at(60, -70, 'a@x.com')).rejects.toBeInstanceOf(HotsauceError)
    expect(await places.at(60, -70, 'b@x.com')).not.toBeNull()
  })
})
