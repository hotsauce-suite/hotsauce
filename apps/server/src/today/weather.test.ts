import { describe, expect, it, vi } from 'vitest'
import { HearthError } from '../errors.js'
import {
  roundPlace,
  summarize,
  WEATHER_FAILURE_TTL_MS,
  WEATHER_MISSES_PER_MINUTE,
  WEATHER_TTL_MS,
  Weather,
} from './weather.js'

// H6: the header's weather, from MET Norway, rounded and cached.

const NOW = Date.parse('2026-11-13T15:10:00Z')

function met(temps: number[], symbol = 'partlycloudy_day') {
  return {
    properties: {
      meta: { updated_at: '2026-11-13T14:00:00Z' },
      timeseries: temps.map((t, i) => ({
        time: new Date(Date.parse('2026-11-13T15:00:00Z') + i * 3_600_000).toISOString(),
        data: {
          instant: { details: { air_temperature: t } },
          ...(i === 0 ? { next_1_hours: { summary: { symbol_code: symbol } } } : {}),
        },
      })),
    },
  }
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  )
}

describe('Weather', () => {
  it('rounds the place to two decimals', () => {
    expect(roundPlace(44.47589, -73.21234)).toEqual({ lat: 44.48, lon: -73.21 })
  })

  it('summarizes now, and the high and low over the next day', () => {
    const temps = [3, 5, 9, 1, ...Array.from({ length: 30 }, () => 4), 40]
    const view = summarize(met(temps), NOW)
    expect(view).toMatchObject({ temperature: 3, high: 9, low: 1, symbol: 'partlycloudy_day' })
    expect(summarize({}, NOW)).toBeNull()
  })

  it('asks MET with a User-Agent and a rounded place, then answers from its cache', async () => {
    let now = NOW
    const fetch = fakeFetch(met([2, 4]))
    const weather = new Weather({ fetch, now: () => now, version: '0.8.0' })
    await weather.forecast(44.47589, -73.21234)
    await weather.forecast(44.4801, -73.2149)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toContain('lat=44.48&lon=-73.21')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['User-Agent']).toBe('Hotsauce/0.8.0 https://hotsauce.work')
    now += WEATHER_TTL_MS + 1
    await weather.forecast(44.48, -73.21)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails plainly when MET is down, and keeps a stale answer when it has one', async () => {
    let now = NOW
    let down = false
    const fetch = vi.fn(async () =>
      down ? new Response('no', { status: 503 }) : Response.json(met([7, 8])),
    )
    const weather = new Weather({ fetch, now: () => now })
    await expect(new Weather({ fetch: fakeFetch({}, 500) }).forecast(1, 2)).rejects.toThrow(
      HearthError,
    )
    await weather.forecast(1, 2)
    down = true
    now += WEATHER_TTL_MS + 1
    await expect(weather.forecast(1, 2)).resolves.toMatchObject({ temperature: 7 })
  })

  it('does not ask MET again for a place that just failed', async () => {
    let now = NOW
    const fetch = fakeFetch({}, 500)
    const weather = new Weather({ fetch, now: () => now })
    await expect(weather.forecast(1, 2)).rejects.toThrow(HearthError)
    await expect(weather.forecast(1, 2)).rejects.toThrow(HearthError)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += WEATHER_FAILURE_TTL_MS + 1
    await expect(weather.forecast(1, 2)).rejects.toThrow(HearthError)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('limits each member’s new places per minute, but not cached ones or other members', async () => {
    let now = NOW
    const fetch = fakeFetch(met([5]))
    const weather = new Weather({ fetch, now: () => now })
    for (let i = 0; i < WEATHER_MISSES_PER_MINUTE; i++) await weather.forecast(i, 0, 'a@x')
    await expect(weather.forecast(50, 0, 'a@x')).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(weather.forecast(0, 0, 'a@x')).resolves.toMatchObject({ temperature: 5 })
    await expect(weather.forecast(50, 0, 'b@x')).resolves.toMatchObject({ temperature: 5 })
    now += 60_001
    await expect(weather.forecast(51, 0, 'a@x')).resolves.toMatchObject({ temperature: 5 })
  })
})
