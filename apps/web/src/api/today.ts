// Client for `GET /api/today` (ARCHITECTURE §16): the Today page in one read.

import type { TodayLayout } from '@hearth/format'
import { request } from './client'
import type { TaskView } from './tasks'
import type { MeetingActionItems } from './types'

export interface TodayMeeting {
  id: string
  title: string
  start: string
  end: string
  attendees: Array<{ email: string; name?: string }>
  meetLink: string | null
  note: { space: string; path: string } | null
  prep: { space: string; path: string; title: string; date: string; line: string } | null
}

export interface TodayView {
  date: string
  meetings: { events: TodayMeeting[]; error: string | null }
  tasks: TaskView[]
  actionItems: MeetingActionItems[]
  notes: Array<{
    space: string
    id: string
    path: string
    title: string
    body: string
    created: string
  }>
  docs: Array<{ space: string; path: string; title: string; changed: string; team: boolean }>
  briefcast: null
}

/** The member's own day: local midnight to midnight, and its date. */
export function localDay(now = new Date()): { from: string; to: string; date: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
  }
}

/** The member's tile layout (ARCHITECTURE §16.4); `saved` is false while it's the default. */
export interface TodayLayoutView {
  layout: TodayLayout
  saved: boolean
}

/** The header's weather (ARCHITECTURE §16.5), in °C. */
export interface TodayWeather {
  temperature: number
  symbol: string
  high: number
  low: number
  updated: string
  credit: string
  /** The team default's name, when the weather is for that. */
  place?: string
}

/** A place found by name (`GET /api/today/places`), position rounded to about 1 km. */
export interface WeatherPlace {
  name: string
  /** Region and country, e.g. "Vermont, United States". */
  detail: string
  lat: number
  lon: number
}

export const todayApi = {
  get: (now = new Date()) => request<TodayView>('/api/today', { query: localDay(now) }),
  layout: () => request<TodayLayoutView>('/api/today/layout'),
  saveLayout: (layout: TodayLayout) =>
    request<TodayLayoutView>('/api/today/layout', { method: 'PUT', json: { layout } }),
  /** With no place: the team's default, or null when the team has none. */
  weather: (place?: { lat: number; lon: number }) =>
    request<TodayWeather | null>(
      '/api/today/weather',
      place ? { query: { lat: String(place.lat), lon: String(place.lon) } } : {},
    ),
  places: (q: string) => request<{ places: WeatherPlace[] }>('/api/today/places', { query: { q } }),
  defaultPlace: () => request<{ place: WeatherPlace | null }>('/api/today/default-place'),
  setDefaultPlace: (place: WeatherPlace | null) =>
    request<{ place: WeatherPlace | null }>('/api/today/default-place', {
      method: 'PUT',
      json: { place },
    }),
}
