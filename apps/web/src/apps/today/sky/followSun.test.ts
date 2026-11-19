import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseTheme, SUN_SCHEME_KEY, storedTheme } from '../../../lib/theme'
import { WEATHER_PLACE_KEY } from '../weatherPlace'
import { rememberTeamPlace, sunPlace, sunScheme, TEAM_PLACE_KEY } from './followSun'

const MONTPELIER = { lat: 44.26, lon: -72.58 }

afterEach(() => {
  vi.useRealTimers()
  chooseTheme('system')
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Follow the sun (R9)', () => {
  it('is light between sunrise and sunset at the place, dark otherwise', () => {
    expect(sunScheme(new Date('2026-11-19T17:00:00Z'), MONTPELIER)).toBe('light')
    expect(sunScheme(new Date('2026-11-19T11:40:00Z'), MONTPELIER)).toBe('dark')
    expect(sunScheme(new Date('2026-11-19T21:40:00Z'), MONTPELIER)).toBe('dark')
  })

  it('follows the clock without a place', () => {
    expect(sunScheme(new Date(2026, 10, 19, 12), null)).toBe('light')
    expect(sunScheme(new Date(2026, 10, 19, 20), null)).toBe('dark')
  })

  it('uses this device’s weather place, else the team’s remembered one', () => {
    expect(sunPlace()).toBeNull()
    rememberTeamPlace(MONTPELIER)
    expect(sunPlace()).toEqual(MONTPELIER)
    localStorage.setItem(WEATHER_PLACE_KEY, JSON.stringify({ lat: 51.5, lon: -0.12 }))
    expect(sunPlace()).toEqual({ lat: 51.5, lon: -0.12 })
    rememberTeamPlace(null)
    expect(localStorage.getItem(TEAM_PLACE_KEY)).toBeNull()
  })

  it('applies light or dark now, remembers it for the first paint, and flips at sunset', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T21:10:00Z'))
    localStorage.setItem(WEATHER_PLACE_KEY, JSON.stringify(MONTPELIER))
    chooseTheme('sun')
    expect(storedTheme()).toBe('sun')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(SUN_SCHEME_KEY)).toBe('light')
    vi.setSystemTime(new Date('2026-11-19T21:40:00Z'))
    vi.advanceTimersByTime(60_000)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(SUN_SCHEME_KEY)).toBe('dark')
    // Choosing another look stops following.
    chooseTheme('light')
    vi.setSystemTime(new Date('2026-11-20T03:00:00Z'))
    vi.advanceTimersByTime(60_000)
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
