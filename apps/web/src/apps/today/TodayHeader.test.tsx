import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView } from '../../api/tasks'
import type { TodayMeeting, TodayView } from '../../api/today'
import { renderApp } from '../../test/renderApp'
import {
  describeWeather,
  formatTemperature,
  greeting,
  nextUp,
  usesFahrenheit,
  WEATHER_PLACE_KEY,
} from './TodayHeader'

const NOW = new Date(2026, 10, 13, 9, 50)

function meeting(title: string, startMin: number, lengthMin = 30, meetLink: string | null = null) {
  const start = new Date(NOW.getTime() + startMin * 60_000)
  return {
    id: title,
    title,
    start: start.toISOString(),
    end: new Date(start.getTime() + lengthMin * 60_000).toISOString(),
    attendees: [],
    meetLink,
    note: null,
    prep: null,
  } satisfies TodayMeeting
}

function view(events: TodayMeeting[], due: Array<string | null> = []): TodayView {
  return {
    date: '2026-11-13',
    meetings: { events, error: null },
    tasks: due.map((d, i) => ({ id: String(i), due: d }) as unknown as TaskView),
    actionItems: [],
    notes: [],
    docs: [],
    briefcast: null,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(WEATHER_PLACE_KEY)
})

describe('Today header (H1–H4)', () => {
  it('H2: greets by the hour, with the first name', () => {
    expect(greeting(new Date(2026, 10, 13, 8), 'Morgan Holland')).toBe('Good morning, Morgan')
    expect(greeting(new Date(2026, 10, 13, 13))).toBe('Good afternoon')
    expect(greeting(new Date(2026, 10, 13, 19), 'Sam')).toBe('Good evening, Sam')
    // Still up in the small hours: evening, not morning.
    expect(greeting(new Date(2026, 10, 13, 2))).toBe('Good evening')
  })

  it('H3: names the next meeting, with Join only when it is close and has a link', () => {
    const soon = nextUp(view([meeting('Standup', 12, 15, 'https://meet.google.com/abc')]), NOW)
    expect(soon.meeting).toEqual({
      title: 'Standup',
      when: 'in 12 min',
      join: 'https://meet.google.com/abc',
    })
    const later = nextUp(view([meeting('Review', 130, 30, 'https://meet.google.com/x')]), NOW)
    expect(later.meeting?.when).toMatch(/^at /)
    expect(later.meeting?.join).toBeNull()
    const now = nextUp(view([meeting('Done', -60), meeting('Sync', -5)]), NOW)
    expect(now.meeting?.title).toBe('Sync')
    expect(now.meeting?.when).toBe('now')
    expect(nextUp(view([meeting('Done', -60)]), NOW).noMeetings).toBe('No more meetings today')
    expect(nextUp(view([]), NOW).noMeetings).toBe('No meetings today')
  })

  it('H4: counts tasks due and overdue', () => {
    expect(nextUp(view([], ['2026-11-13', '2026-11-13', '2026-11-10']), NOW).tasks).toBe(
      '2 tasks due · 1 overdue',
    )
    expect(nextUp(view([], ['2026-11-13']), NOW).tasks).toBe('1 task due')
    expect(nextUp(view([], []), NOW).tasks).toBeNull()
  })

  it('H1: the top bar shows the time and the full day', async () => {
    renderApp('/today')
    expect(await screen.findByTestId('today-time')).toHaveTextContent(/\d{1,2}:\d{2}/)
    const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' })
    expect(screen.getByTestId('today-date')).toHaveTextContent(weekday)
    expect(await screen.findByTestId('today-greeting')).toHaveTextContent(
      /^Good (morning|afternoon|evening)/,
    )
  })
})

describe('Today weather (H5)', () => {
  it('uses °F for the US and °C elsewhere, and names MET symbols', () => {
    expect(usesFahrenheit('en-US')).toBe(true)
    expect(usesFahrenheit('en-GB')).toBe(false)
    expect(formatTemperature(0, true)).toBe('32°')
    expect(formatTemperature(7.4, false)).toBe('7°')
    expect(describeWeather('lightrainshowers_day').words).toBe('Light rain')
    expect(describeWeather('clearsky_night').emoji).toBe('🌙')
  })

  it('is off until asked, then shows the weather and remembers the rounded place', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 44.47589, longitude: -73.21234 } } as GeolocationPosition),
    )
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    })
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-weather-on'))
    expect(await screen.findByTestId('today-weather')).toHaveTextContent(/\d+°/)
    expect(JSON.parse(localStorage.getItem(WEATHER_PLACE_KEY) ?? '')).toEqual({
      lat: 44.48,
      lon: -73.21,
    })
    // W8: its menu names the place and hides it, which this device remembers.
    await userEvent.click(screen.getByTestId('today-weather'))
    expect(await screen.findByTestId('today-weather-where')).toHaveTextContent(
      'Weather for your location',
    )
    await userEvent.click(screen.getByTestId('today-weather-hide'))
    expect(await screen.findByTestId('today-weather-on')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(WEATHER_PLACE_KEY) ?? '')).toEqual({ off: true })
  })

  it('W3: offers Allow location and a city when location is refused', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, fail: PositionErrorCallback) =>
      fail({ code: 1 } as GeolocationPositionError),
    )
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    })
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-weather-on'))
    expect(await screen.findByTestId('today-weather-denied')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('today-weather-allow'))
    expect(getCurrentPosition).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('today-weather-city')).toBeInTheDocument()
  })

  it('W4: shows the weather for a city picked by name, kept on this device', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
          fail({ code: 1 } as GeolocationPositionError),
      },
    })
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-weather-on'))
    await userEvent.click(await screen.findByTestId('today-weather-city'))
    await userEvent.type(await screen.findByTestId('weather-city-input'), 'Burl')
    const results = await screen.findAllByTestId('weather-city-result')
    expect(results[0]).toHaveTextContent('Burlington')
    expect(results[0]).toHaveTextContent('Vermont, United States')
    await userEvent.click(results[0] as HTMLElement)
    expect(await screen.findByTestId('today-weather')).toHaveTextContent(/\d+°/)
    expect(JSON.parse(localStorage.getItem(WEATHER_PLACE_KEY) ?? '')).toEqual({
      name: 'Burlington',
      detail: 'Vermont, United States',
      lat: 44.48,
      lon: -73.21,
    })
    await userEvent.click(screen.getByTestId('today-weather'))
    expect(await screen.findByTestId('today-weather-where')).toHaveTextContent(
      'Weather for Burlington',
    )
  })

  it('W1: in the Mac app, asks the app instead of the web view', async () => {
    const postMessage = vi.fn(async (_m: unknown) => ({ lat: 44.4759, lon: -73.2121 }))
    const getCurrentPosition = vi.fn()
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    })
    ;(window as unknown as { webkit?: unknown }).webkit = {
      messageHandlers: { hearthLocation: { postMessage }, hearthSignIn: { postMessage: vi.fn() } },
    }
    try {
      renderApp('/today')
      await userEvent.click(await screen.findByTestId('today-weather-on'))
      expect(await screen.findByTestId('today-weather')).toBeInTheDocument()
      expect(postMessage).toHaveBeenCalledWith('position')
      expect(getCurrentPosition).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem(WEATHER_PLACE_KEY) ?? '')).toEqual({
        lat: 44.48,
        lon: -73.21,
      })
    } finally {
      delete (window as unknown as { webkit?: unknown }).webkit
    }
  })

  it('W1: an older Mac app points to a city instead of asking again', async () => {
    ;(window as unknown as { webkit?: unknown }).webkit = {
      messageHandlers: { hearthSignIn: { postMessage: vi.fn() } },
    }
    try {
      renderApp('/today')
      await userEvent.click(await screen.findByTestId('today-weather-on'))
      expect(await screen.findByTestId('today-weather-denied')).toHaveTextContent(
        'Update the Mac app',
      )
      expect(screen.queryByTestId('today-weather-allow')).toBeNull()
      expect(screen.getByTestId('today-weather-city')).toBeInTheDocument()
    } finally {
      delete (window as unknown as { webkit?: unknown }).webkit
    }
  })

  it('W7: shows the team city without asking, until this device hides it', async () => {
    await fetch('/api/today/default-place', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        place: { name: 'Oslo', detail: 'Oslo, Norway', lat: 59.91, lon: 10.75 },
      }),
    })
    const getCurrentPosition = vi.fn()
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    })
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-weather'))
    expect(await screen.findByTestId('today-weather-where')).toHaveTextContent('Weather for Oslo')
    expect(getCurrentPosition).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('today-weather-hide'))
    expect(await screen.findByTestId('today-weather-on')).toBeInTheDocument()
  })
})
