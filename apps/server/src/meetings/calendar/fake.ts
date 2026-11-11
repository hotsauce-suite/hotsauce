import type { Principal } from '../../auth/index.js'
import type { CalendarEvent, CalendarSource } from './types.js'

const MINUTE = 60_000

/**
 * The calendar in dev auth mode, where there is no Google account: two events relative to now,
 * one starting in a minute (so the "take notes" nudge shows) and one later.
 */
export class FakeCalendar implements CalendarSource {
  readonly #now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now
  }

  async upcoming(
    principal: Principal,
    range: { from: string; to: string },
  ): Promise<CalendarEvent[]> {
    const from = Date.parse(range.from)
    const to = Date.parse(range.to)
    return this.events(principal).filter(
      (e) => Date.parse(e.end) > from && Date.parse(e.start) < to,
    )
  }

  events(principal: Principal): CalendarEvent[] {
    const now = this.#now()
    // Whole minutes, so a reload a few seconds later shows the same times.
    const soon = Math.ceil(now / MINUTE) * MINUTE + MINUTE
    const me = { email: principal.email, name: principal.name }
    return [
      {
        id: 'fake-acme-sync',
        title: 'Acme sync',
        start: new Date(soon).toISOString(),
        end: new Date(soon + 30 * MINUTE).toISOString(),
        attendees: [me, { email: 'dana@acme.com', name: 'Dana Lee' }],
        description: 'Agenda: SSO timeline, pricing one-pager.',
        meetLink: 'https://meet.google.com/abc-defg-hij',
        seriesId: 'fake-acme-series',
      },
      {
        id: 'fake-design-review',
        title: 'Design review',
        start: new Date(soon + 120 * MINUTE).toISOString(),
        end: new Date(soon + 165 * MINUTE).toISOString(),
        attendees: [me, { email: 'sam@example.test', name: 'Sam Rivera' }],
      },
    ]
  }
}
