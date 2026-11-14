import { describe, expect, it, vi } from 'vitest'
import { HearthError } from '../errors.js'
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
    await expect(places.search('One more', 'a@x')).rejects.toBeInstanceOf(HearthError)
    // Someone else, and a cached query, still work.
    await places.search('One more', 'b@x')
    await places.search('City 1', 'a@x')
  })
})
