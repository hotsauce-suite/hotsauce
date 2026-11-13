// The Today header (ARCHITECTURE §16.5, plan H1–H5): a live clock and the date in the top bar,
// and under it a greeting with what's next. Weather is opt-in and stays on this device.

import { useEffect, useState } from 'react'
import { HearthApiError } from '../../api/client'
import { type TodayView, type TodayWeather, todayApi } from '../../api/today'
import { timeLabel } from '../meetings/format'

/** This device remembers where to show weather for: rounded to about 1 km. */
export const WEATHER_PLACE_KEY = 'hotsauce.today.weatherPlace'
const WEATHER_EVERY_MS = 20 * 60_000

/** Ticks once a minute, on the minute, so the clock never shows a stale time. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const d = new Date()
      timer = setTimeout(
        () => {
          setNow(new Date())
          schedule()
        },
        60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 20,
      )
    }
    schedule()
    // Waking a sleeping laptop: catch up at once.
    const wake = () => {
      if (document.visibilityState === 'visible') setNow(new Date())
    }
    document.addEventListener('visibilitychange', wake)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])
  return now
}

export function greeting(now: Date, name?: string): string {
  const h = now.getHours()
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Good ${part}, ${first}` : `Good ${part}`
}

export interface NextUp {
  meeting: {
    title: string
    when: string
    /** A Meet link to join, when it starts within 15 minutes (or has started). */
    join: string | null
  } | null
  /** "No more meetings today" or "No meetings today", when there's no next meeting. */
  noMeetings: string | null
  tasks: string | null
}

/** H3, H4: the next meeting that hasn't ended, and the tasks due. */
export function nextUp(view: TodayView, now: Date): NextUp {
  const events = view.meetings.error ? [] : view.meetings.events
  const next = events
    .filter((e) => Date.parse(e.end) > now.getTime())
    .sort((a, b) => a.start.localeCompare(b.start))[0]
  let meeting: NextUp['meeting'] = null
  if (next) {
    const minutes = Math.ceil((Date.parse(next.start) - now.getTime()) / 60_000)
    const when =
      minutes <= 0
        ? 'now'
        : minutes < 60
          ? `in ${minutes} min`
          : `at ${timeLabel(new Date(next.start))}`
    meeting = { title: next.title, when, join: minutes <= 15 ? next.meetLink : null }
  }
  const overdue = view.tasks.filter((t) => t.due !== null && t.due.slice(0, 10) < view.date)
  const due = view.tasks.length - overdue.length
  const parts: string[] = []
  if (due > 0) parts.push(due === 1 ? '1 task due' : `${due} tasks due`)
  if (overdue.length > 0) parts.push(`${overdue.length} overdue`)
  return {
    meeting,
    noMeetings: next
      ? null
      : view.meetings.error
        ? null
        : events.length > 0
          ? 'No more meetings today'
          : 'No meetings today',
    tasks: parts.length > 0 ? parts.join(' · ') : null,
  }
}

/** °F where the browser's region uses it, °C everywhere else. */
export function usesFahrenheit(locale = navigator.language): boolean {
  return /-(US|LR|MM|BS|BZ|KY|PW|FM|MH)\b/i.test(locale)
}

export function formatTemperature(celsius: number, fahrenheit: boolean): string {
  return `${Math.round(fahrenheit ? (celsius * 9) / 5 + 32 : celsius)}°`
}

/** MET Norway's symbol codes, e.g. `lightrainshowers_day`, as an emoji and a few words. */
export function describeWeather(symbol: string): { emoji: string; words: string } {
  const night = symbol.endsWith('_night')
  const s = symbol.replace(/_(day|night|polartwilight)$/, '')
  if (s.includes('thunder')) return { emoji: '⛈️', words: 'Thunder' }
  if (s.includes('sleet')) return { emoji: '🌨️', words: 'Sleet' }
  if (s.includes('snow')) return { emoji: '❄️', words: s.includes('light') ? 'Light snow' : 'Snow' }
  if (s.includes('rain'))
    return {
      emoji: '🌧️',
      words: s.includes('light') ? 'Light rain' : s.includes('heavy') ? 'Heavy rain' : 'Rain',
    }
  if (s === 'fog') return { emoji: '🌫️', words: 'Fog' }
  if (s === 'cloudy') return { emoji: '☁️', words: 'Cloudy' }
  if (s === 'partlycloudy') return { emoji: night ? '☁️' : '⛅', words: 'Partly cloudy' }
  if (s === 'fair') return { emoji: night ? '🌙' : '🌤️', words: 'Mostly clear' }
  if (s === 'clearsky') return { emoji: night ? '🌙' : '☀️', words: 'Clear' }
  return { emoji: '🌡️', words: '' }
}

function readPlace(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(WEATHER_PLACE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { lat?: unknown; lon?: unknown }
    return typeof p.lat === 'number' && typeof p.lon === 'number'
      ? { lat: p.lat, lon: p.lon }
      : null
  } catch {
    return null
  }
}

function writePlace(place: { lat: number; lon: number } | null) {
  try {
    if (place) localStorage.setItem(WEATHER_PLACE_KEY, JSON.stringify(place))
    else localStorage.removeItem(WEATHER_PLACE_KEY)
  } catch {
    // Shown for this visit only.
  }
}

type WeatherState =
  | { kind: 'off' }
  | { kind: 'asking' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }
  | { kind: 'shown'; weather: TodayWeather }

/** H5: off until the member asks; then the browser's position, rounded, kept on this device. */
function useWeather() {
  const [place, setPlace] = useState(readPlace)
  const [state, setState] = useState<WeatherState>(() =>
    readPlace() ? { kind: 'asking' } : { kind: 'off' },
  )

  useEffect(() => {
    if (!place) return
    let cancelled = false
    const load = () =>
      todayApi.weather(place).then(
        (weather) => {
          if (!cancelled) setState({ kind: 'shown', weather })
        },
        (err) => {
          if (!cancelled)
            setState((s) =>
              // Keep the last reading on a failed refresh.
              s.kind === 'shown'
                ? s
                : {
                    kind: 'error',
                    message: err instanceof HearthApiError ? err.message : 'No weather right now',
                  },
            )
        },
      )
    void load()
    const every = setInterval(() => void load(), WEATHER_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(every)
    }
  }, [place])

  const turnOn = () => {
    if (!('geolocation' in navigator)) {
      setState({ kind: 'error', message: 'This browser can’t share its location' })
      return
    }
    setState({ kind: 'asking' })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = {
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
        }
        writePlace(p)
        setPlace(p)
      },
      () => setState({ kind: 'denied' }),
      { maximumAge: 6 * 3_600_000, timeout: 15_000 },
    )
  }
  const turnOff = () => {
    writePlace(null)
    setPlace(null)
    setState({ kind: 'off' })
  }
  return { state, turnOn, turnOff }
}

/** The right side of the top bar: weather, the time, the day. */
export function TodayClock() {
  const now = useMinuteClock()
  const weather = useWeather()
  return (
    <div className="flex items-center gap-3 text-sm text-ink-soft">
      <WeatherChip {...weather} />
      <time
        dateTime={now.toISOString()}
        className="flex items-baseline gap-2 whitespace-nowrap"
        data-testid="today-clock"
      >
        <span className="font-semibold text-ink tabular-nums" data-testid="today-time">
          {timeLabel(now)}
        </span>
        <span className="hidden sm:inline" data-testid="today-date">
          {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </time>
    </div>
  )
}

function WeatherChip({
  state,
  turnOn,
  turnOff,
}: {
  state: WeatherState
  turnOn: () => void
  turnOff: () => void
}) {
  const quiet = 'whitespace-nowrap text-xs text-ink-faint'
  switch (state.kind) {
    case 'off':
      return (
        <button
          type="button"
          onClick={turnOn}
          data-testid="today-weather-on"
          className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <span className="sm:hidden">Weather</span>
          <span className="hidden sm:inline">Show weather</span>
        </button>
      )
    case 'asking':
      return <span className={quiet}>Weather…</span>
    case 'denied':
      return (
        <button type="button" onClick={turnOn} className={quiet} data-testid="today-weather-denied">
          Location is blocked for weather
        </button>
      )
    case 'error':
      return (
        <button type="button" onClick={turnOff} className={quiet} title="Hide weather">
          {state.message}
        </button>
      )
    case 'shown': {
      const f = usesFahrenheit()
      const { emoji, words } = describeWeather(state.weather.symbol)
      const t = (c: number) => formatTemperature(c, f)
      return (
        <button
          type="button"
          onClick={turnOff}
          data-testid="today-weather"
          title={`${words}. High ${t(state.weather.high)}, low ${t(state.weather.low)}. Weather from ${state.weather.credit}. Click to hide.`}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 hover:bg-paper-sunk"
        >
          <span aria-hidden="true">{emoji}</span>
          <span className="font-medium text-ink tabular-nums">{t(state.weather.temperature)}</span>
          <span className="hidden text-xs text-ink-faint lg:inline">
            {words ? `${words} · ` : ''}
            {t(state.weather.high)} / {t(state.weather.low)}
          </span>
        </button>
      )
    }
  }
}

/** The greeting and what's next, at the top of the page. */
export function TodayGreeting({
  view,
  name,
  now,
}: {
  view: TodayView | null
  name?: string | undefined
  now: Date
}) {
  const next = view ? nextUp(view, now) : null
  return (
    <div className="min-w-0 flex-1">
      <p
        className="font-display text-2xl font-semibold tracking-tight text-ink"
        data-testid="today-greeting"
      >
        {greeting(now, name)}
      </p>
      {next ? (
        <p
          className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-ink-soft"
          data-testid="today-next"
        >
          {next.meeting ? (
            <span data-testid="today-next-meeting">
              <span className="font-medium text-ink">{next.meeting.title}</span> {next.meeting.when}
              {next.meeting.join ? (
                <>
                  {' '}
                  <a
                    href={next.meeting.join}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="today-next-join"
                    className="ml-1 rounded-md bg-ember px-2 py-0.5 text-xs font-medium text-paper-raised hover:bg-ember-strong"
                  >
                    Join
                  </a>
                </>
              ) : null}
            </span>
          ) : next.noMeetings ? (
            <span>{next.noMeetings}</span>
          ) : null}
          {next.tasks ? (
            <>
              <span
                aria-hidden="true"
                className={next.meeting || next.noMeetings ? 'text-ink-faint' : 'hidden'}
              >
                ·
              </span>
              <span data-testid="today-next-tasks">{next.tasks}</span>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
