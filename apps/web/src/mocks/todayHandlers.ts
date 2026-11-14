// MSW route for `GET /api/today` (ARCHITECTURE §16). It asks the other mock routes, the way the
// server asks its services, so the mock's Today always agrees with its Tasks, Notes and Meetings.

import {
  addTile,
  defaultTodayLayout,
  moveTile,
  parseTodayLayout,
  type TodayLayout,
} from '@hearth/format'
import { type AnyHandler, HttpResponse, http } from 'msw'
import type { TaskView } from '../api/tasks'
import type { TodayMeeting, TodayView, TodayWeather, WeatherPlace } from '../api/today'
import type { CalendarEvent, MeetingActionItems } from '../api/types'

const DAY_MS = 86_400_000

/** The demo shows off the newer tiles; dev and tests start from the real default. */
function startingLayout(): TodayLayout | null {
  if (import.meta.env.MODE !== 'demo') return null
  let layout = addTile(defaultTodayLayout(), 'week')
  layout = moveTile(layout, 'week', { column: 1, index: 0 })
  layout = addTile(layout, 'starred')
  layout = addTile(layout, 'dictate')
  return layout
}

/** Partly cloudy and cool, whatever the place. */
const SAMPLE_WEATHER: Omit<TodayWeather, 'updated'> = {
  temperature: 7.4,
  symbol: 'partlycloudy_day',
  high: 11.2,
  low: 2.8,
  credit: 'MET Norway',
}

/** A few places the demo's city search knows, matched by the start of their name. */
const SAMPLE_PLACES: WeatherPlace[] = [
  { name: 'Burlington', detail: 'Vermont, United States', lat: 44.48, lon: -73.21 },
  { name: 'Burlington', detail: 'Ontario, Canada', lat: 43.32, lon: -79.79 },
  { name: 'Boston', detail: 'Massachusetts, United States', lat: 42.36, lon: -71.06 },
  { name: 'London', detail: 'England, United Kingdom', lat: 51.51, lon: -0.13 },
  { name: 'Oslo', detail: 'Oslo, Norway', lat: 59.91, lon: 10.75 },
  { name: 'San Francisco', detail: 'California, United States', lat: 37.77, lon: -122.42 },
]

export function todayHandlers(): AnyHandler[] {
  // One layout per member, for as long as the page is open.
  const layouts = new Map<string, TodayLayout>()
  // The team's default weather place (Settings → Organization → Weather); none to start.
  let teamPlace: WeatherPlace | null = null
  const who = (request: Request) => request.headers.get('x-hearth-dev-user') ?? 'me'
  return [
    http.get('/api/today/layout', ({ request }) => {
      const saved = layouts.get(who(request)) ?? startingLayout()
      return HttpResponse.json({ layout: saved ?? defaultTodayLayout(), saved: saved !== null })
    }),
    http.put('/api/today/layout', async ({ request }) => {
      const body = (await request.json()) as { layout?: unknown }
      try {
        const layout = parseTodayLayout(body.layout)
        layouts.set(who(request), layout)
        return HttpResponse.json({ layout, saved: true })
      } catch (err) {
        return HttpResponse.json(
          { error: { code: 'bad_request', message: (err as Error).message } },
          { status: 400 },
        )
      }
    }),
    http.get('/api/today/weather', ({ request }) => {
      const url = new URL(request.url)
      const sample = { ...SAMPLE_WEATHER, updated: new Date().toISOString() }
      if (url.searchParams.has('lat')) return HttpResponse.json(sample)
      return HttpResponse.json(teamPlace ? { ...sample, place: teamPlace.name } : null)
    }),
    http.get('/api/today/places', ({ request }) => {
      const q = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase()
      const places =
        q.length < 2 ? [] : SAMPLE_PLACES.filter((p) => p.name.toLowerCase().startsWith(q))
      return HttpResponse.json({ places })
    }),
    http.get('/api/today/default-place', () => HttpResponse.json({ place: teamPlace })),
    http.put('/api/today/default-place', async ({ request }) => {
      const body = (await request.json()) as { place?: WeatherPlace | null }
      teamPlace = body.place ?? null
      return HttpResponse.json({ place: teamPlace })
    }),
    http.get('/api/today', async ({ request }) => {
      const url = new URL(request.url)
      const from = url.searchParams.get('from') ?? ''
      const to = url.searchParams.get('to') ?? ''
      const date = url.searchParams.get('date') ?? ''
      const ask = async <T>(path: string): Promise<{ ok: boolean; status: number; body: T }> => {
        const res = await fetch(new URL(path, url.origin), { headers: request.headers })
        const body = (await res.json()) as T
        return { ok: res.ok, status: res.status, body }
      }
      const tasks = await ask<{ tasks: TaskView[] } | TaskView[]>(
        `/api/tasks?status=open&mine=true&due_before=${date}`,
      )
      if (!tasks.ok) return HttpResponse.json(tasks.body, { status: tasks.status })
      const calendar = await ask<CalendarEvent[] | { error: { message: string } }>(
        `/api/calendar/upcoming?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      )
      const actionItems = await ask<MeetingActionItems[]>('/api/tasks/from-meetings')
      const notes = await ask<
        { notes: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
      >('/api/notes')
      const since = new Date(Date.now() - DAY_MS).toISOString()
      const noteList = Array.isArray(notes.body) ? notes.body : (notes.body.notes ?? [])
      const view: TodayView = {
        date,
        meetings: Array.isArray(calendar.body)
          ? {
              error: null,
              events: calendar.body.map(
                (e): TodayMeeting => ({
                  id: e.id,
                  title: e.title,
                  start: e.start,
                  end: e.end,
                  attendees: e.attendees,
                  meetLink: e.meetLink ?? null,
                  note: null,
                  prep: null,
                }),
              ),
            }
          : { events: [], error: calendar.body.error.message },
        tasks: Array.isArray(tasks.body) ? tasks.body : tasks.body.tasks,
        actionItems: actionItems.ok ? actionItems.body : [],
        notes: noteList
          .filter(
            (n) =>
              n.pinned !== true &&
              Array.isArray(n.labels) &&
              n.labels.length === 0 &&
              String(n.created) >= since,
          )
          .map((n) => ({
            space: String(n.space),
            id: String(n.id),
            path: String(n.path),
            title: String(n.title ?? ''),
            body: String(n.body ?? ''),
            created: String(n.created),
          })),
        docs: [],
        briefcast: null,
      }
      return HttpResponse.json(view)
    }),
  ]
}
