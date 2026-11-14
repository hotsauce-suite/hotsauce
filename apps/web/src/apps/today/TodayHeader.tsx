// The Today header (ARCHITECTURE §16.5, plan H1–H5): a live clock and the date in the top bar,
// and under it a greeting with what's next. Weather is for this device's place or the team's.

import { useEffect, useRef, useState } from 'react'
import { HearthApiError } from '../../api/client'
import { type TodayView, type TodayWeather, todayApi, type WeatherPlace } from '../../api/today'
import { Dialog } from '../../components/Dialog'
import { below, Menu, type MenuAnchor, MenuItem } from '../../components/Menu'
import { PlaceSearch } from '../../components/PlaceSearch'
import { timeLabel } from '../meetings/format'
import { askLocation, inMacApp, useDeviceWeather, writeDeviceWeather } from './weatherPlace'

export { WEATHER_PLACE_KEY } from './weatherPlace'

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

type WeatherState =
  | { kind: 'off' }
  | { kind: 'asking' }
  | { kind: 'denied' }
  | { kind: 'oldMacApp' }
  | { kind: 'error'; message: string }
  | { kind: 'shown'; weather: TodayWeather; where: string }

/**
 * H5, W1–W8: the device's own place (a shared position or a typed city), else the team's
 * default, else off until the member asks. Refreshed every 20 minutes.
 */
function useWeather() {
  const device = useDeviceWeather()
  const [state, setState] = useState<WeatherState>(() =>
    device.kind === 'off' ? { kind: 'off' } : { kind: 'asking' },
  )
  const [picking, setPicking] = useState(false)
  /** A failed "Use my location" while weather was showing: said briefly, the weather kept. */
  const [notice, setNotice] = useState<string | null>(null)
  /** While the position is being asked for, a refresh doesn't change what the chip shows. */
  const asking = useRef(false)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 10_000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (device.kind === 'off') {
      setState({ kind: 'off' })
      return
    }
    let cancelled = false
    const place = device.kind === 'place' ? device.place : undefined
    const load = () =>
      todayApi.weather(place).then(
        (weather) => {
          if (cancelled || asking.current) return
          if (!weather) {
            // No place of its own and no team default: off until asked.
            setState((s) => (s.kind === 'denied' || s.kind === 'oldMacApp' ? s : { kind: 'off' }))
            return
          }
          const where = place ? (place.name ?? 'your location') : (weather.place ?? 'your team')
          setState({ kind: 'shown', weather, where })
        },
        (err) => {
          if (!cancelled && !asking.current)
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
  }, [device])

  const shareLocation = async () => {
    const before = state
    asking.current = true
    setNotice(null)
    setState({ kind: 'asking' })
    const result = await askLocation()
    asking.current = false
    if (result.kind === 'place') {
      writeDeviceWeather({ kind: 'place', place: result.place })
    } else if (before.kind === 'shown') {
      // Keep the weather that was working; say why the location wasn't used.
      setState(before)
      setNotice(
        result.kind === 'unavailable'
          ? result.message
          : result.kind === 'oldMacApp'
            ? 'Update the Mac app to use your location'
            : 'Location is blocked',
      )
    } else if (result.kind === 'unavailable') {
      setState({ kind: 'error', message: result.message })
    } else {
      setState({ kind: result.kind })
    }
  }
  const pickCity = (place: WeatherPlace) => {
    setPicking(false)
    writeDeviceWeather({ kind: 'place', place })
  }
  const hide = () => writeDeviceWeather({ kind: 'off' })
  return { state, shareLocation, pickCity, hide, picking, setPicking, notice }
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
  shareLocation,
  pickCity,
  hide,
  picking,
  setPicking,
  notice,
}: ReturnType<typeof useWeather>) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const quiet = 'whitespace-nowrap text-xs text-ink-faint'
  const small =
    'whitespace-nowrap rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-paper-sunk hover:text-ink'
  const cityDialog = picking ? (
    <Dialog
      title="Weather for a city"
      onClose={() => setPicking(false)}
      testId="weather-city-dialog"
    >
      <PlaceSearch onPick={pickCity} autoFocus testId="weather-city" />
      <p className="mt-3 text-xs text-ink-faint">
        Kept on this device only. Change it any time in Settings → Weather.
      </p>
    </Dialog>
  ) : null
  const blocked = (text: string, allow: boolean) => (
    <span className="flex items-center gap-1" data-testid="today-weather-denied">
      <span className={`${quiet} hidden md:inline`}>{text}</span>
      {allow ? (
        <button
          type="button"
          onClick={() => void shareLocation()}
          data-testid="today-weather-allow"
          title={
            inMacApp()
              ? 'Opens System Settings if location is off for this app'
              : 'If nothing happens, allow location for this site from the address bar, then try again'
          }
          className="whitespace-nowrap rounded-md border border-ember/50 px-2 py-0.5 text-xs font-medium text-ember-strong hover:bg-ember-wash"
        >
          Allow location
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setPicking(true)}
        data-testid="today-weather-city"
        className={small}
      >
        Use a city
      </button>
      {cityDialog}
    </span>
  )
  switch (state.kind) {
    case 'off':
      return (
        <>
          <button
            type="button"
            onClick={() => void shareLocation()}
            data-testid="today-weather-on"
            className={small}
          >
            <span className="sm:hidden">Weather</span>
            <span className="hidden sm:inline">Show weather</span>
          </button>
          {cityDialog}
        </>
      )
    case 'asking':
      return <span className={quiet}>Weather…</span>
    case 'denied':
      return blocked(inMacApp() ? 'Location is off for this app.' : 'Location is blocked.', true)
    case 'oldMacApp':
      return blocked('Update the Mac app to use your location.', false)
    case 'error':
      return blocked(state.message, true)
    case 'shown': {
      const f = usesFahrenheit()
      const { emoji, words } = describeWeather(state.weather.symbol)
      const t = (c: number) => formatTemperature(c, f)
      return (
        <>
          {notice ? (
            <span
              className={`${quiet} hidden md:inline`}
              role="status"
              data-testid="today-weather-notice"
            >
              {notice}
            </span>
          ) : null}
          <button
            type="button"
            onClick={(e) => setMenu(below(e.currentTarget))}
            data-testid="today-weather"
            aria-haspopup="menu"
            title={`Weather for ${state.where}: ${words ? `${words}. ` : ''}High ${t(state.weather.high)}, low ${t(state.weather.low)}. From ${state.weather.credit}.`}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 hover:bg-paper-sunk"
          >
            <span aria-hidden="true">{emoji}</span>
            <span className="font-medium text-ink tabular-nums">
              {t(state.weather.temperature)}
            </span>
            <span className="hidden text-xs text-ink-faint lg:inline">
              {words ? `${words} · ` : ''}
              {t(state.weather.high)} / {t(state.weather.low)}
            </span>
          </button>
          {menu ? (
            <Menu anchor={menu} label="Weather" onClose={() => setMenu(null)}>
              <p
                className="px-2.5 pt-1 pb-1.5 text-xs text-ink-faint"
                data-testid="today-weather-where"
              >
                Weather for {state.where}
              </p>
              <MenuItem
                testId="today-weather-use-location"
                onSelect={() => {
                  setMenu(null)
                  void shareLocation()
                }}
              >
                Use my location
              </MenuItem>
              <MenuItem
                testId="today-weather-use-city"
                onSelect={() => {
                  setMenu(null)
                  setPicking(true)
                }}
              >
                Use a city…
              </MenuItem>
              <MenuItem
                testId="today-weather-hide"
                onSelect={() => {
                  setMenu(null)
                  hide()
                }}
              >
                Hide weather
              </MenuItem>
            </Menu>
          ) : null}
          {cityDialog}
        </>
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
