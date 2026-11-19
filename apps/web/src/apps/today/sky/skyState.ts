// What Today's sky needs from elsewhere on the page (docs/PLAN-today-sky.md): the scene this
// device picked, and the weather the header last showed (so the sky asks the service nothing).

import { useEffect, useState, useSyncExternalStore } from 'react'
import { todayApi, type WeatherPlace } from '../../../api/today'
import { useDeviceWeather } from '../weatherPlace'
import type { Place } from './sunMoon'

export type SkyScene = 'sky' | 'path' | 'off'
export const SKY_SCENE_KEY = 'hotsauce.today.scene'
const SCENE_CHANGED = 'hotsauce:today-scene'

export const SKY_SCENES: { value: SkyScene; label: string; detail: string }[] = [
  { value: 'sky', label: 'Sky', detail: 'The sky for the time of day, with the sun or moon' },
  { value: 'path', label: 'Sun path', detail: 'A thin line with the sun along it' },
  { value: 'off', label: 'Off', detail: 'No picture' },
]

export function readSkyScene(): SkyScene {
  try {
    const v = localStorage.getItem(SKY_SCENE_KEY)
    return v === 'path' || v === 'off' ? v : 'sky'
  } catch {
    return 'sky'
  }
}

export function writeSkyScene(scene: SkyScene) {
  try {
    if (scene === 'sky') localStorage.removeItem(SKY_SCENE_KEY)
    else localStorage.setItem(SKY_SCENE_KEY, scene)
  } catch {
    // Private window: for this visit only.
  }
  window.dispatchEvent(new CustomEvent(SCENE_CHANGED, { detail: scene }))
}

export function useSkyScene(): SkyScene {
  const [scene, setScene] = useState(readSkyScene)
  useEffect(() => {
    const changed = (e: Event) => setScene((e as CustomEvent<SkyScene>).detail)
    const storage = (e: StorageEvent) => {
      if (e.key === SKY_SCENE_KEY) setScene(readSkyScene())
    }
    window.addEventListener(SCENE_CHANGED, changed)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(SCENE_CHANGED, changed)
      window.removeEventListener('storage', storage)
    }
  }, [])
  return scene
}

/**
 * Where the sky is for: this device's weather place, else the team's default place, else none
 * (the sky then follows the clock). Hiding the weather doesn't hide the sun.
 */
export function useSkyPlace(): Place | null | undefined {
  const device = useDeviceWeather()
  const [team, setTeam] = useState<WeatherPlace | null | undefined>(undefined)
  const devicePlace = device.kind === 'place' ? device.place : null
  useEffect(() => {
    if (devicePlace) return
    let cancelled = false
    todayApi.defaultPlace().then(
      (r) => {
        if (!cancelled) setTeam(r.place)
      },
      () => {
        if (!cancelled) setTeam(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [devicePlace])
  if (devicePlace) return { lat: devicePlace.lat, lon: devicePlace.lon }
  if (team === undefined) return undefined
  return team ? { lat: team.lat, lon: team.lon } : null
}

// The weather symbol the header shows now (MET Norway's code), or null when it shows none.
let symbol: string | null = null
const listeners = new Set<() => void>()

export function publishSkyWeather(next: string | null) {
  if (next === symbol) return
  symbol = next
  for (const l of listeners) l()
}

export function useSkyWeather(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => symbol,
  )
}
