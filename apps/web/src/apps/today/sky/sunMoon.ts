// Sunrise, sunset, twilight and the moon's phase, worked out on the device from a place
// (docs/PLAN-today-sky.md). No service is asked: the sun's position is the standard almanac
// formula (as NOAA and suncalc use), good to a minute or two; the moon's phase is its mean
// age, good to within a day, which is enough to draw and name it.

export interface Place {
  lat: number
  lon: number
}

export type SunTimes =
  | {
      kind: 'normal'
      sunrise: Date
      sunset: Date
      /** Civil twilight: the sun 6° below the horizon. */
      dawn?: Date
      dusk?: Date
    }
  | { kind: 'alwaysUp' }
  | { kind: 'alwaysDown' }

const DAY_MS = 86_400_000
const J1970 = 2440588
const J2000 = 2451545
const RAD = Math.PI / 180
const OBLIQUITY = RAD * 23.4397
const J0 = 0.0009

const toDays = (date: Date) => date.getTime() / DAY_MS - 0.5 + J1970 - J2000
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS)

function solar(d: number) {
  const M = RAD * (357.5291 + 0.98560028 * d)
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  const L = M + C + RAD * 102.9372 + Math.PI
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L))
  return { M, L, dec }
}

const transit = (ds: number, M: number, L: number) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L)

/** When the sun's centre crosses `angle` degrees above the horizon on the day around `date`. */
function crossing(date: Date, place: Place, angle: number) {
  const lw = RAD * -place.lon
  const phi = RAD * place.lat
  const n = Math.round(toDays(date) - J0 - lw / (2 * Math.PI))
  const ds = J0 + lw / (2 * Math.PI) + n
  const { M, L, dec } = solar(ds)
  const noon = transit(ds, M, L)
  const cosW =
    (Math.sin(RAD * angle) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
  if (cosW < -1) return { kind: 'alwaysUp' as const }
  if (cosW > 1) return { kind: 'alwaysDown' as const }
  const w = Math.acos(cosW)
  const set = transit(J0 + (w + lw) / (2 * Math.PI) + n, M, L)
  const rise = noon - (set - noon)
  return { kind: 'normal' as const, rise: fromJulian(rise), set: fromJulian(set) }
}

/**
 * The sun on `date`'s calendar day on this device, at `place`: the upper edge touching the
 * horizon, with refraction. Worked out from that day's noon, so a time just after midnight
 * doesn't land on the solar day before.
 */
export function sunTimes(date: Date, place: Place): SunTimes {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
  const sun = crossing(noon, place, -0.833)
  if (sun.kind !== 'normal') return sun
  const civil = crossing(noon, place, -6)
  return civil.kind === 'normal'
    ? { kind: 'normal', sunrise: sun.rise, sunset: sun.set, dawn: civil.rise, dusk: civil.set }
    : { kind: 'normal', sunrise: sun.rise, sunset: sun.set }
}

/** How far the sun is along its arc: 0 at sunrise, 1 at sunset, null while it's down. */
export function sunProgress(now: Date, times: SunTimes): number | null {
  if (times.kind === 'alwaysUp') return 0.5
  if (times.kind === 'alwaysDown') return null
  const t = now.getTime()
  const rise = times.sunrise.getTime()
  const set = times.sunset.getTime()
  if (t < rise || t > set) return null
  return (t - rise) / (set - rise)
}

export type SkyPhase = 'dawn' | 'day' | 'dusk' | 'night'

const GLOW_MS = 30 * 60_000

/** The time of day the sky shows. Without a place, it follows the clock. */
export function skyPhase(now: Date, times: SunTimes | null): SkyPhase {
  if (!times) {
    const h = now.getHours() + now.getMinutes() / 60
    if (h >= 5 && h < 7.5) return 'dawn'
    if (h >= 7.5 && h < 17) return 'day'
    if (h >= 17 && h < 19.5) return 'dusk'
    return 'night'
  }
  if (times.kind === 'alwaysUp') return 'day'
  if (times.kind === 'alwaysDown') return 'night'
  const t = now.getTime()
  const rise = times.sunrise.getTime()
  const set = times.sunset.getTime()
  const dawn = times.dawn?.getTime() ?? rise - GLOW_MS
  const dusk = times.dusk?.getTime() ?? set + GLOW_MS
  if (t >= dawn && t < rise + GLOW_MS) return 'dawn'
  if (t >= rise + GLOW_MS && t < set - GLOW_MS) return 'day'
  if (t >= set - GLOW_MS && t < dusk) return 'dusk'
  return 'night'
}

export interface MoonPhase {
  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  age: number
  /** The lit share of the disc, 0 to 1. */
  illumination: number
  name: string
}

const SYNODIC = 29.530588853
/** A new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_JD = 2451550.26

export function moonPhase(date: Date): MoonPhase {
  const jd = date.getTime() / DAY_MS + J1970 - 0.5
  const cycles = (jd - NEW_MOON_JD) / SYNODIC
  const age = cycles - Math.floor(cycles)
  const illumination = (1 - Math.cos(2 * Math.PI * age)) / 2
  return { age, illumination, name: phaseName(age) }
}

function phaseName(age: number): string {
  const day = age * SYNODIC
  if (day < 1 || day > SYNODIC - 1) return 'New moon'
  if (day < 6.4) return 'Waxing crescent'
  if (day < 8.4) return 'First quarter'
  if (day < 13.8) return 'Waxing gibbous'
  if (day < 15.8) return 'Full moon'
  if (day < 21.1) return 'Waning gibbous'
  if (day < 23.1) return 'Last quarter'
  return 'Waning crescent'
}
