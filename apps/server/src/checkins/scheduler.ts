import type { PushSender } from '../meetings/reminders/sender.js'
import type { ReminderStore, Subscriber } from '../meetings/reminders/store.js'
import { currentRound } from './schedule.js'
import type { Checkins } from './service.js'

const TICK_MS = 30_000
/** A round is reminded for this long after it opens (a server that was briefly down still asks). */
export const CHECKIN_REMINDER_LATE_MS = 10 * 60_000

export function checkinReminderKey(email: string, id: string, date: string): string {
  return `checkin ${email.toLowerCase()} ${id} ${date}`
}

/**
 * Check-ins' clock (ARCHITECTURE §24.3): every 30 seconds, a web push to each asked member whose
 * round has just opened in their zone (once per round, not after they answered), then any round
 * summaries that are due. Push goes to the browsers that turned on meeting reminders.
 */
export class CheckinScheduler {
  readonly #checkins: Pick<Checkins, 'active' | 'askedWithZones' | 'hasAnswered' | 'summarizeDue'>
  readonly #push: { store: ReminderStore; sender: PushSender } | null
  readonly #now: () => Date
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setInterval> | null = null
  #running: Promise<void> | null = null

  constructor(opts: {
    checkins: Pick<Checkins, 'active' | 'askedWithZones' | 'hasAnswered' | 'summarizeDue'>
    push: { store: ReminderStore; sender: PushSender } | null
    now?: () => Date
    log?: (message: string) => void
  }) {
    this.#checkins = opts.checkins
    this.#push = opts.push
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

  async #tick(): Promise<void> {
    try {
      await this.#remind()
    } catch (err) {
      this.#log(`checkin reminders: ${err}`)
    }
    try {
      await this.#checkins.summarizeDue()
    } catch (err) {
      this.#log(`checkin summaries: ${err}`)
    }
  }

  async #remind(): Promise<void> {
    if (!this.#push) return
    const { store, sender } = this.#push
    const now = this.#now()
    const byMember = new Map<string, Subscriber[]>()
    for (const s of await store.subscribers()) {
      const email = s.principal.email.toLowerCase()
      byMember.set(email, [...(byMember.get(email) ?? []), s])
    }
    if (byMember.size === 0) return
    for (const fm of this.#checkins.active()) {
      for (const { email, tz } of await this.#checkins.askedWithZones(fm)) {
        const subs = byMember.get(email)
        if (!subs) continue
        const round = currentRound(fm, now, tz)
        if (!round || now.getTime() - round.opensAt.getTime() > CHECKIN_REMINDER_LATE_MS) continue
        const key = checkinReminderKey(email, fm.id, round.date)
        if (await store.wasSent(key)) continue
        if (this.#checkins.hasAnswered(fm.id, round.date, email)) continue
        const payload = {
          title: fm.title,
          body: 'Check-in: tap to answer',
          url: `/checkins/${fm.id}`,
          tag: `checkin-${fm.id}-${round.date}`,
        }
        let delivered = false
        for (const sub of subs) {
          try {
            const result = await sender.send(sub.subscription, payload)
            if (result === 'gone') await store.unsubscribe(sub.subscription.endpoint)
            else delivered = true
          } catch (err) {
            this.#log(`checkin push to ${email} failed: ${err}`)
          }
        }
        if (delivered) await store.markSent(key, now.getTime())
      }
    }
  }
}
