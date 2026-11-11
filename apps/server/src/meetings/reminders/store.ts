import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Principal } from '../../auth/index.js'
import { KeyedMutex } from '../../git/mutex.js'

const Subscription = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})
export type PushSubscription = z.infer<typeof Subscription>

/** The browsers' push services: Chrome and other Chromium browsers, Firefox, Edge, Safari. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
]

/**
 * The server POSTs to a subscription's endpoint, so a member could otherwise point it anywhere,
 * the server's own network included. Only https on a browser push service is accepted.
 */
export function isPushService(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname))
  } catch {
    return false
  }
}

/** A subscription as a browser sends it (POST /api/meetings/reminders). */
export const PushSubscriptionSchema = Subscription.refine((s) => isPushService(s.endpoint), {
  message: 'Not a browser push service',
  path: ['endpoint'],
})

const Entry = z.object({
  principal: z.object({
    userId: z.string(),
    email: z.string(),
    name: z.string(),
    handle: z.string(),
    isAdmin: z.boolean(),
  }),
  subscription: Subscription,
})
export type Subscriber = z.infer<typeof Entry>

const State = z.object({
  subscribers: z.array(Entry).default([]),
  /** `<email> <event id> <start>` → when its reminder went out (ms); pruned after a day. */
  sent: z.record(z.string(), z.number()).default({}),
})
type State = z.infer<typeof State>

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Browsers that asked for meeting reminders, and the reminders already sent. Device state, not
 * member data: it lives on the volume (`DATA_DIR/push/state.json`), never in Git, and losing it
 * only means each browser turns reminders on again.
 */
export class ReminderStore {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  #state: State | null = null

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'push', 'state.json')
  }

  /**
   * An endpoint is one browser profile. Subscribing it again, say after another member signed
   * in on the same browser, moves it to the newest subscriber.
   */
  async subscribe(principal: Principal, subscription: PushSubscription): Promise<void> {
    await this.#update((s) => {
      s.subscribers = s.subscribers.filter((e) => e.subscription.endpoint !== subscription.endpoint)
      s.subscribers.push({ principal: { ...principal }, subscription })
    })
  }

  /** Removes the endpoint; with `email`, only if it belongs to that member. */
  async unsubscribe(endpoint: string, email?: string): Promise<void> {
    await this.#update((s) => {
      s.subscribers = s.subscribers.filter(
        (e) =>
          e.subscription.endpoint !== endpoint ||
          (email !== undefined && e.principal.email !== email),
      )
    })
  }

  async subscribers(): Promise<Subscriber[]> {
    return (await this.#load()).subscribers
  }

  async wasSent(key: string): Promise<boolean> {
    return key in (await this.#load()).sent
  }

  /** Records the reminder; false if it was already sent. */
  async markSent(key: string, now: number): Promise<boolean> {
    let fresh = false
    await this.#update((s) => {
      for (const [k, at] of Object.entries(s.sent)) if (now - at > DAY_MS) delete s.sent[k]
      if (key in s.sent) return
      s.sent[key] = now
      fresh = true
    })
    return fresh
  }

  async #load(): Promise<State> {
    if (this.#state) return this.#state
    try {
      this.#state = State.parse(JSON.parse(await readFile(this.#file, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`push: ${this.#file} is unreadable, starting empty: ${err}`)
      }
      this.#state = { subscribers: [], sent: {} }
    }
    return this.#state
  }

  #update(change: (s: State) => void): Promise<void> {
    return this.#lock.run('state', async () => {
      const state = await this.#load()
      change(state)
      await mkdir(path.dirname(this.#file), { recursive: true })
      await writeFile(`${this.#file}.tmp`, JSON.stringify(state))
      await rename(`${this.#file}.tmp`, this.#file)
    })
  }
}
