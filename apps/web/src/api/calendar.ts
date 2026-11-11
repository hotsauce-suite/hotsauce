// Client for `/api/calendar` (ARCHITECTURE §7.2, §7.8): the member's Google Calendar, read-only,
// served from the server's cache.

import { request } from './client'
import type {
  CalendarChoice,
  CalendarEvent,
  CalendarMatch,
  CalendarStatus,
  CoverageItem,
} from './types'

export const calendarApi = {
  /** Events overlapping `[from, to)`, ISO timestamps. */
  upcoming: (range: { from: string; to: string }) =>
    request<CalendarEvent[]>('/api/calendar/upcoming', { query: range }),
  status: () => request<CalendarStatus>('/api/calendar/status'),
  /** Syncs with Google unless the last attempt was under a minute ago. */
  refresh: () => request<CalendarStatus>('/api/calendar/refresh', { method: 'POST' }),
  /** The event a Meet call (`abc-defg-hij`) belongs to. */
  match: (meet: string) => request<CalendarMatch>('/api/calendar/match', { query: { meet } }),
  /** Past meetings with others and their notes; the server defaults to the last 14 days. */
  coverage: (range: { from?: string; to?: string } = {}) =>
    request<CoverageItem[]>('/api/calendar/coverage', { query: range }),
  calendars: () => request<{ calendars: CalendarChoice[] }>('/api/calendar/calendars'),
  /** The extra calendars to sync; primary is implied. */
  setCalendars: (ids: string[]) =>
    request<{ calendars: CalendarChoice[] }>('/api/calendar/calendars', {
      method: 'PUT',
      json: { ids },
    }),
}
