// "Follow the sun" (docs/PLAN-today-sky.md R9): light from sunrise to sunset, dark otherwise,
// at the place Today's sky uses. Read at boot without a network call, so the team's place is
// remembered here once Today has fetched it.

import { readDeviceWeather } from '../weatherPlace'
import { type Place, sunTimes } from './sunMoon'

export const TEAM_PLACE_KEY = 'hotsauce.today.teamPlace'

export function rememberTeamPlace(place: Place | null) {
  try {
    if (place)
      localStorage.setItem(TEAM_PLACE_KEY, JSON.stringify({ lat: place.lat, lon: place.lon }))
    else localStorage.removeItem(TEAM_PLACE_KEY)
  } catch {
    // Private window: the clock decides instead.
  }
}

function teamPlace(): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(TEAM_PLACE_KEY) ?? 'null') as Partial<Place> | null
    return p && typeof p.lat === 'number' && typeof p.lon === 'number'
      ? { lat: p.lat, lon: p.lon }
      : null
  } catch {
    return null
  }
}

/** The place the sun is followed at: this device's weather place, else the team's, else none. */
export function sunPlace(): Place | null {
  const device = readDeviceWeather()
  if (device.kind === 'place') return { lat: device.place.lat, lon: device.place.lon }
  return teamPlace()
}

/** Light while the sun is up; without a place, from 7:00 to 17:00 by the clock. */
export function sunScheme(now: Date, place: Place | null): 'light' | 'dark' {
  if (!place) {
    const h = now.getHours() + now.getMinutes() / 60
    return h >= 7 && h < 17 ? 'light' : 'dark'
  }
  const t = sunTimes(now, place)
  if (t.kind === 'alwaysUp') return 'light'
  if (t.kind === 'alwaysDown') return 'dark'
  return now >= t.sunrise && now < t.sunset ? 'light' : 'dark'
}
