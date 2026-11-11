import type { CalendarEvent, CalendarSource } from '../calendar/types.js'
import type { PushSender } from './sender.js'
import type { ReminderStore, Subscriber } from './store.js'

/** A reminder goes out when an event starts within this window: about a minute before. */
const LEAD_MS = 90_000
const TICK_MS = 30_000
/** Each pass refreshes a subscribed member's calendar if it wasn't in the last minute. */
const REFRESH_MAX_AGE_MS = 60_000

/** Once per member, event and start: a moved meeting is reminded again at its new time. */
function reminderKey(email: string, event: CalendarEvent): string {
  return `${email} ${event.id} ${event.start}`
}

/**
 * PRD §6.1: a web push a minute before each calendar event with attendees, "Take notes for
 * <title>?", opening Start for that event. Every member who turned reminders on is checked every
 * 30 seconds; each event is reminded once per member, on every browser they subscribed.
 */
export class MeetingReminders {
  readonly #store: ReminderStore
  readonly #calendar: CalendarSource
  readonly #sender: PushSender
  readonly #now: () => Date
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setInterval> | null = null
  /** Each member's last calendar error, so a broken connection is logged once, not every tick. */
  readonly #calendarErrors = new Map<string, string>()
  #running: Promise<void> | null = null

  constructor(opts: {
    store: ReminderStore
    calendar: CalendarSource
    sender: PushSender
    now?: () => Date
    log?: (message: string) => void
  }) {
    this.#store = opts.store
    this.#calendar = opts.calendar
    this.#sender = opts.sender
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? console.error
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#running
  }

  /** One pass; a pass still running is joined rather than doubled. */
  tick(): Promise<void> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  /** Events with attendees starting in the next LEAD_MS, from the calendar. */
  async #due(principal: Subscriber['principal'], now: Date): Promise<CalendarEvent[]> {
    const events = await this.#calendar.upcoming(principal, {
      from: now.toISOString(),
      to: new Date(now.getTime() + LEAD_MS).toISOString(),
    })
    return events.filter((event) => {
      const start = Date.parse(event.start)
      return event.attendees.length > 0 && start > now.getTime() && start <= now.getTime() + LEAD_MS
    })
  }

  async #tick(): Promise<void> {
    const now = this.#now()
    const byMember = new Map<string, Subscriber[]>()
    for (const s of await this.#store.subscribers()) {
      byMember.set(s.principal.email, [...(byMember.get(s.principal.email) ?? []), s])
    }
    for (const [email, subs] of byMember) {
      const principal = subs[0]?.principal
      if (!principal) continue
      try {
        // Catch a meeting moved, cancelled or added in the last minute or so. A refresh that
        // fails leaves the cache as it was, so a cached reminder still goes out (§7.8).
        await this.#calendar.refresh?.(principal, { maxAgeMs: REFRESH_MAX_AGE_MS })
        const events = await this.#due(principal, now)
        for (const event of events) {
          const key = reminderKey(email, event)
          if (await this.#store.wasSent(key)) continue
          const payload = {
            title: `Take notes for “${event.title}”?`,
            body: 'It starts in about a minute.',
            url: `/meetings/start?event=${encodeURIComponent(event.id)}`,
            tag: `meeting-${event.id}`,
          }
          let delivered = false
          for (const sub of subs) {
            try {
              const result = await this.#sender.send(sub.subscription, payload)
              if (result === 'gone') await this.#store.unsubscribe(sub.subscription.endpoint)
              else delivered = true
            } catch (err) {
              this.#log(`push to ${email} failed: ${err}`)
            }
          }
          // Not one browser got it: the next tick tries again while the event is still ahead.
          if (delivered) await this.#store.markSent(key, now.getTime())
        }
        this.#calendarErrors.delete(email)
      } catch (err) {
        // Calendar not connected, or Google is down; try again next tick, logging it once.
        const message = String(err)
        if (this.#calendarErrors.get(email) !== message) {
          this.#calendarErrors.set(email, message)
          this.#log(`reminders for ${email}: ${message}`)
        }
      }
    }
  }
}
