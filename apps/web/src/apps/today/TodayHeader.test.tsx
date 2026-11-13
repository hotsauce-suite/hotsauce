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
    // Clicking it hides it again and forgets the place.
    await userEvent.click(screen.getByTestId('today-weather'))
    await waitFor(() => expect(localStorage.getItem(WEATHER_PLACE_KEY)).toBeNull())
    expect(screen.getByTestId('today-weather-on')).toBeInTheDocument()
  })

  it('says so quietly when location is refused', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
          fail({ code: 1 } as GeolocationPositionError),
      },
    })
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('today-weather-on'))
    expect(await screen.findByTestId('today-weather-denied')).toBeInTheDocument()
  })
})
