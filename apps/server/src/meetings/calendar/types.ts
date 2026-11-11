import type { Principal } from '../../auth/index.js'

export interface CalendarEvent {
  id: string
  title: string
  /** ISO timestamps. */
  start: string
  end: string
  attendees: Array<{ email: string; name?: string }>
  description?: string
  meetLink?: string
  /** Google's `recurringEventId`: the series a recurring event's instance belongs to. */
  seriesId?: string
  /** The Google calendar it came from, when not the primary one. */
  calendarId?: string
}

export interface CalendarSource {
  /** Timed events overlapping `from`..`to` (ISO timestamps), in start order. */
  upcoming(principal: Principal, range: { from: string; to: string }): Promise<CalendarEvent[]>
  /**
   * Bring the member's events up to date unless that was tried within `maxAgeMs` (the cached
   * calendar, ARCHITECTURE §7.8). Sources that read live don't have it.
   */
  refresh?(principal: Principal, opts: { maxAgeMs: number }): Promise<void>
}

/** An event by id from around `at` (a day either side), or null. */
export async function findEvent(
  calendar: CalendarSource,
  principal: Principal,
  id: string,
  at: Date,
): Promise<CalendarEvent | null> {
  const day = 24 * 60 * 60 * 1000
  const from = new Date(at.getTime() - day).toISOString()
  const to = new Date(at.getTime() + day).toISOString()
  return (await calendar.upcoming(principal, { from, to })).find((e) => e.id === id) ?? null
}
