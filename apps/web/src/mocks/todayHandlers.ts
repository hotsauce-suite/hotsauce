// MSW route for `GET /api/today` (ARCHITECTURE §16). It asks the other mock routes, the way the
// server asks its services, so the mock's Today always agrees with its Tasks, Notes and Meetings.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type { TaskView } from '../api/tasks'
import type { TodayMeeting, TodayView } from '../api/today'
import type { CalendarEvent, MeetingActionItems } from '../api/types'

const DAY_MS = 86_400_000

export function todayHandlers(): AnyHandler[] {
  return [
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
