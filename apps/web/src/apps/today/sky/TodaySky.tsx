// Today's sky (docs/PLAN-today-sky.md): a band behind the greeting whose colours follow the time
// of day and the member's theme, with the sun at its true place along its arc or, after dark, the
// moon in its real phase. The weather the header shows drifts across it lightly. Everything is
// still under "reduce motion".

import { type CSSProperties, type ReactNode, useMemo } from 'react'
import { Link } from 'react-router'
import { timeLabel } from '../../meetings/format'
import { type SkyScene, useSkyPlace, useSkyScene, useSkyWeather } from './skyState'
import {
  moonPhase,
  type Place,
  type SkyPhase,
  type SunTimes,
  skyPhase,
  sunProgress,
  sunTimes,
} from './sunMoon'

/**
 * Each time of day as two sky colours and how much of each goes into the theme's paper. The day
 * mixes are light enough that the theme's own text keeps 4.5:1 or better in Hotsauce's light and
 * dark looks; the night sky is dark in every theme and gets light text of its own (NIGHT_TEXT).
 */
const SKY: Record<SkyPhase, { top: string; bottom: string; topMix: number; bottomMix: number }> = {
  dawn: { top: '#7f8fd6', bottom: '#f6a87a', topMix: 30, bottomMix: 24 },
  day: { top: '#5fa8e8', bottom: '#bfe0f5', topMix: 32, bottomMix: 24 },
  dusk: { top: '#5b4d9e', bottom: '#f08a5d', topMix: 24, bottomMix: 20 },
  night: { top: '#0d1636', bottom: '#2b3466', topMix: 88, bottomMix: 88 },
}

/** Light text over the night sky, whatever the theme. */
const NIGHT_TEXT = {
  '--ink': '#f4efe6',
  '--ink-soft': '#d6cdbf',
  '--ink-faint': '#b3aa9c',
} as CSSProperties

const blend = (color: string, mix: number) => `color-mix(in oklab, ${color} ${mix}%, var(--paper))`

export interface SkyWeatherKind {
  clouds: 0 | 1 | 2
  rain: boolean
  snow: boolean
  fog: boolean
}

/** MET Norway's symbol code as what to draw. */
export function weatherKind(symbol: string | null): SkyWeatherKind {
  const s = (symbol ?? '').replace(/_(day|night|polartwilight)$/, '')
  const rain = /rain|sleet|thunder/.test(s)
  const snow = /snow|sleet/.test(s)
  const fog = s === 'fog'
  const clouds =
    s === 'cloudy' || rain || snow || fog ? 2 : s === 'partlycloudy' || s === 'fair' ? 1 : 0
  return { clouds, rain, snow, fog }
}

/** "Sunrise 6:58 · Sunset 4:17 · 9h 19m of daylight", or what's next once the sun has set. */
export function sunLine(now: Date, today: SunTimes, tomorrow: SunTimes): string {
  if (today.kind === 'alwaysUp') return 'The sun stays up all day today'
  if (today.kind === 'alwaysDown') return 'The sun stays below the horizon today'
  if (now.getTime() > today.sunset.getTime()) {
    return tomorrow.kind === 'normal'
      ? `Sunset was ${timeLabel(today.sunset)} · Sunrise tomorrow ${timeLabel(tomorrow.sunrise)}`
      : `Sunset was ${timeLabel(today.sunset)}`
  }
  const minutes = Math.round((today.sunset.getTime() - today.sunrise.getTime()) / 60_000)
  const length = `${Math.floor(minutes / 60)}h ${minutes % 60}m of daylight`
  return `Sunrise ${timeLabel(today.sunrise)} · Sunset ${timeLabel(today.sunset)} · ${length}`
}

/** Where along the night the moon is drawn: 0 at sunset, 1 at the next sunrise. */
function nightProgress(now: Date, place: Place | null): number {
  if (!place) {
    // No place: the night runs from 17:00 to 7:00 by the clock, as clockSun's day ends and starts.
    const h = now.getHours() + now.getMinutes() / 60
    const since = (h - 17 + 24) % 24
    return Math.min(1, since / 14)
  }
  const yesterday = sunTimes(new Date(now.getTime() - 86_400_000), place)
  const today = sunTimes(now, place)
  const tomorrow = sunTimes(new Date(now.getTime() + 86_400_000), place)
  const t = now.getTime()
  let from: number | null = null
  let to: number | null = null
  if (today.kind === 'normal' && t < today.sunrise.getTime()) {
    from = yesterday.kind === 'normal' ? yesterday.sunset.getTime() : null
    to = today.sunrise.getTime()
  } else if (today.kind === 'normal') {
    from = today.sunset.getTime()
    to = tomorrow.kind === 'normal' ? tomorrow.sunrise.getTime() : null
  }
  if (from === null || to === null) return 0.5
  return Math.max(0, Math.min(1, (t - from) / (to - from)))
}

/** A point along the arc, in percent of the band: x across, y down from the top. */
function arcPoint(p: number) {
  return { x: 6 + p * 88, y: 82 - Math.sin(Math.PI * p) * 62 }
}

// A few stars at fixed places, the same every night.
const STARS = Array.from({ length: 22 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  return { x: r(1) * 100, y: r(2) * 70, size: r(3) < 0.25 ? 2 : 1, delay: r(4) * 4 }
})

/** The moon's lit part as a path in a 40×40 box; waning moons are lit on the left. */
export function moonPath(age: number): string {
  const r = 18
  const c = 20
  const lit = (1 - Math.cos(2 * Math.PI * age)) / 2
  const rx = Math.abs(1 - 2 * lit) * r
  const gibbous = lit > 0.5 ? 1 : 0
  return `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx.toFixed(2)} ${r} 0 0 ${gibbous} ${c} ${c - r} Z`
}

export function TodaySky({ now, children }: { now: Date; children: ReactNode }) {
  const scene = useSkyScene()
  const place = useSkyPlace()
  const symbol = useSkyWeather()
  if (scene === 'off') return <>{children}</>
  return (
    <SkyBand scene={scene} now={now} place={place} symbol={symbol}>
      {children}
    </SkyBand>
  )
}

export function SkyBand({
  scene,
  now,
  place,
  symbol,
  children,
}: {
  scene: Exclude<SkyScene, 'off'>
  now: Date
  /** Undefined while the team's place is still being asked for. */
  place: Place | null | undefined
  symbol: string | null
  children: ReactNode
}) {
  const day = now.toDateString()
  const minute = Math.floor(now.getTime() / 60_000)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once a day per place is enough
  const times = useMemo(() => {
    if (!place) return null
    return {
      today: sunTimes(now, place),
      tomorrow: sunTimes(new Date(now.getTime() + 86_400_000), place),
    }
  }, [day, place?.lat, place?.lon])
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed each minute
  const view = useMemo(() => {
    const phase = skyPhase(now, times?.today ?? null)
    const sunP = times ? sunProgress(now, times.today) : clockSun(now)
    const moon = moonPhase(now)
    return { phase, sunP, moon, moonP: sunP === null ? nightProgress(now, place ?? null) : null }
  }, [minute, times, place?.lat, place?.lon])
  const sky = SKY[view.phase]
  const weather = weatherKind(symbol)
  const night = view.phase === 'night' || view.phase === 'dusk'
  const line = times ? sunLine(now, times.today, times.tomorrow) : null
  const sunAt = view.sunP === null ? null : arcPoint(view.sunP)
  const moonAt = view.moonP === null ? null : arcPoint(view.moonP)
  const sunTitle = line ?? 'Set your place in Settings to see sunrise and sunset'
  const moonTitle = `${view.moon.name}, ${Math.round(view.moon.illumination * 100)}% lit`

  return (
    <div className="w-full" data-testid="today-sky" data-scene={scene} data-phase={view.phase}>
      <div
        className="sky-band relative isolate overflow-hidden rounded-2xl px-5 pt-20 pb-6 md:px-6 md:pt-5"
        style={
          scene === 'sky'
            ? {
                background: `linear-gradient(180deg, ${blend(sky.top, sky.topMix)} 0%, ${blend(sky.bottom, sky.bottomMix)} 100%)`,
                ...(view.phase === 'night' ? NIGHT_TEXT : {}),
              }
            : { background: 'var(--paper-raised)', border: '1px solid var(--ash)' }
        }
      >
        <div aria-hidden className="sky-art pointer-events-none absolute -z-10 overflow-hidden">
          {scene === 'path' ? (
            <svg
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <path
                d="M 6 82 Q 50 -42 94 82"
                fill="none"
                stroke="var(--ash-strong)"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1="0"
                y1="82"
                x2="100"
                y2="82"
                stroke="var(--ash)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : null}
          {scene === 'sky' && night
            ? STARS.map((s, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                  key={i}
                  className="sky-star absolute rounded-full"
                  style={{
                    left: `${s.x}%`,
                    top: `${s.y}%`,
                    width: s.size,
                    height: s.size,
                    animationDelay: `${s.delay}s`,
                    opacity: view.phase === 'dusk' ? 0.4 : 0.85,
                  }}
                />
              ))
            : null}
          {sunAt ? (
            <span
              className="sky-body absolute"
              data-testid="today-sun"
              style={{ left: `${sunAt.x}%`, top: `${sunAt.y}%` }}
            >
              <span
                className={
                  scene === 'sky'
                    ? 'sky-sun block size-11 rounded-full'
                    : 'block size-3 rounded-full'
                }
                style={scene === 'path' ? { background: 'var(--glow)' } : undefined}
              />
            </span>
          ) : null}
          {moonAt ? (
            <span
              className="sky-body absolute"
              data-testid="today-moon"
              data-moon={view.moon.name}
              style={{ left: `${moonAt.x}%`, top: `${moonAt.y}%` }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 40 40"
                className={scene === 'sky' ? 'sky-moon size-10' : 'size-4'}
              >
                <circle cx="20" cy="20" r="18" fill="currentColor" opacity="0.18" />
                <path
                  d={moonPath(view.moon.age)}
                  fill="currentColor"
                  transform={view.moon.age > 0.5 ? 'translate(40 0) scale(-1 1)' : undefined}
                />
              </svg>
            </span>
          ) : null}
          {scene === 'sky' && weather.clouds > 0 ? (
            <>
              <span
                className="sky-cloud absolute"
                style={{ top: '18%', animationDuration: '90s' }}
              />
              {weather.clouds > 1 ? (
                <span
                  className="sky-cloud absolute"
                  style={{
                    top: '42%',
                    animationDuration: '120s',
                    animationDelay: '-50s',
                    scale: '1.4',
                  }}
                />
              ) : null}
            </>
          ) : null}
          {scene === 'sky' && (weather.rain || weather.snow)
            ? Array.from({ length: 14 }, (_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                  key={i}
                  className={`absolute ${weather.snow && (!weather.rain || i % 2) ? 'sky-flake' : 'sky-drop'}`}
                  style={{
                    left: `${(i * 7.3 + 3) % 100}%`,
                    animationDelay: `${(i * 0.37) % 2.5}s`,
                  }}
                />
              ))
            : null}
          {scene === 'sky' && weather.fog ? <span className="sky-fog absolute inset-0" /> : null}
        </div>
        {/* Hover targets sit above the text so the title tooltip shows; only the body itself takes the pointer. */}
        {sunAt || moonAt ? (
          <div aria-hidden className="sky-art pointer-events-none absolute z-10">
            <span
              title={sunAt ? sunTitle : moonTitle}
              className="pointer-events-auto absolute size-11 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${(sunAt ?? moonAt)?.x}%`, top: `${(sunAt ?? moonAt)?.y}%` }}
            />
          </div>
        ) : null}
        {/* On wider screens the words keep to the left, clear of the sun's arc. */}
        <div className="relative md:max-w-[56%]">{children}</div>
        <p className="relative mt-2 text-xs text-ink-soft" data-testid="today-sun-line">
          {line ? (
            <span>{line}</span>
          ) : place === null ? (
            <Link
              to="/settings"
              state={{ settingsFind: 'Weather' }}
              className="underline hover:text-ink"
              data-testid="today-sky-set-place"
            >
              Set your place for sunrise and sunset
            </Link>
          ) : null}
          {view.moonP !== null ? <span className="sr-only">. {moonTitle}</span> : null}
        </p>
      </div>
    </div>
  )
}

/** Without a place, the sun is up from 7:00 to 17:00 by the clock. */
function clockSun(now: Date): number | null {
  const h = now.getHours() + now.getMinutes() / 60
  return h < 7 || h > 17 ? null : (h - 7) / 10
}
