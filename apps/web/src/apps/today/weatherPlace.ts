// Where this device shows weather for (ARCHITECTURE §16.5, docs/PLAN-weather-place.md). Kept in
// localStorage only: a shared position (rounded to about 1 km), a city picked by name, or "off".
// Nothing set means the team's default place, if an admin chose one.

import { useEffect, useState } from 'react'

export const WEATHER_PLACE_KEY = 'hotsauce.today.weatherPlace'
const CHANGED = 'hotsauce:weather-place'

/** A position; `name` and `detail` when it's a city picked by name. */
export interface DevicePlace {
  lat: number
  lon: number
  name?: string
  detail?: string
}

export type DeviceWeather =
  | { kind: 'unset' }
  | { kind: 'off' }
  | { kind: 'place'; place: DevicePlace }

export function readDeviceWeather(): DeviceWeather {
  try {
    const raw = localStorage.getItem(WEATHER_PLACE_KEY)
    if (!raw) return { kind: 'unset' }
    const p = JSON.parse(raw) as Partial<DevicePlace> & { off?: unknown }
    if (p.off === true) return { kind: 'off' }
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return { kind: 'unset' }
    const place: DevicePlace = { lat: p.lat, lon: p.lon }
    if (typeof p.name === 'string' && p.name) place.name = p.name
    if (typeof p.detail === 'string' && p.detail) place.detail = p.detail
    return { kind: 'place', place }
  } catch {
    return { kind: 'unset' }
  }
}

export function writeDeviceWeather(value: DeviceWeather) {
  try {
    if (value.kind === 'unset') localStorage.removeItem(WEATHER_PLACE_KEY)
    else if (value.kind === 'off')
      localStorage.setItem(WEATHER_PLACE_KEY, JSON.stringify({ off: true }))
    else localStorage.setItem(WEATHER_PLACE_KEY, JSON.stringify(value.place))
  } catch {
    // Private browsing: it applies for this visit only.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }))
}

/** The device's choice, kept current when the header or Settings changes it. */
export function useDeviceWeather(): DeviceWeather {
  const [value, setValue] = useState(readDeviceWeather)
  useEffect(() => {
    const changed = (event: Event) => setValue((event as CustomEvent<DeviceWeather>).detail)
    const storage = (event: StorageEvent) => {
      if (event.key === WEATHER_PLACE_KEY) setValue(readDeviceWeather())
    }
    window.addEventListener(CHANGED, changed)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(CHANGED, changed)
      window.removeEventListener('storage', storage)
    }
  }, [])
  return value
}

export function roundPosition(lat: number, lon: number): DevicePlace {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 }
}

/**
 * - `denied`: the person or the system said no. In the Mac app, the app has already opened
 *   System Settings at Location Services.
 * - `oldMacApp`: a Mac app from before it could share its location.
 */
export type LocationResult =
  | { kind: 'place'; place: DevicePlace }
  | { kind: 'denied' }
  | { kind: 'oldMacApp' }
  | { kind: 'unavailable'; message: string }

interface MessageHandler {
  postMessage(message: unknown): Promise<unknown> | undefined
}

function macHandlers(): Record<string, MessageHandler> | undefined {
  return (window as { webkit?: { messageHandlers?: Record<string, MessageHandler> } }).webkit
    ?.messageHandlers
}

/** Inside the Mac app (any version): its sign-in bridge is always there. */
export function inMacApp(): boolean {
  return Boolean(macHandlers()?.hearthSignIn)
}

/**
 * Asks for this device's position: through the Mac app's own bridge (CoreLocation, since its web
 * view can't), or the browser's. Rounded to about 1 km before it goes anywhere.
 */
export async function askLocation(): Promise<LocationResult> {
  const handlers = macHandlers()
  const mac = handlers?.hearthLocation
  if (mac) {
    try {
      const reply = (await mac.postMessage('position')) as {
        lat?: unknown
        lon?: unknown
        error?: unknown
      } | null
      if (reply && typeof reply.lat === 'number' && typeof reply.lon === 'number') {
        return { kind: 'place', place: roundPosition(reply.lat, reply.lon) }
      }
      if (reply?.error === 'denied') return { kind: 'denied' }
      return { kind: 'unavailable', message: 'Your Mac couldn’t find where you are' }
    } catch {
      return { kind: 'unavailable', message: 'Your Mac couldn’t find where you are' }
    }
  }
  // An older Mac app: its web view turns every request down without asking.
  if (handlers?.hearthSignIn) return { kind: 'oldMacApp' }
  if (!('geolocation' in navigator)) {
    return { kind: 'unavailable', message: 'This browser can’t share its location' }
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ kind: 'place', place: roundPosition(pos.coords.latitude, pos.coords.longitude) }),
      (err) =>
        resolve(
          err.code === 1
            ? { kind: 'denied' }
            : { kind: 'unavailable', message: 'Couldn’t find where you are' },
        ),
      { maximumAge: 6 * 3_600_000, timeout: 15_000 },
    )
  })
}
