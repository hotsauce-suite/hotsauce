import webpush from 'web-push'
import type { PushSubscription } from './store.js'

export interface ReminderPayload {
  title: string
  body: string
  /** Where a click on the notification goes. */
  url: string
  /** One notification per event: a repeat replaces it. */
  tag: string
}

export interface PushSender {
  /** 'gone' when the browser has dropped the subscription; it should be forgotten. */
  send(subscription: PushSubscription, payload: ReminderPayload): Promise<'sent' | 'gone'>
}

/** Web Push with VAPID keys (`npx web-push generate-vapid-keys`). */
export class WebPushSender implements PushSender {
  readonly #vapid: { subject: string; publicKey: string; privateKey: string }

  constructor(vapid: { subject: string; publicKey: string; privateKey: string }) {
    this.#vapid = vapid
  }

  async send(subscription: PushSubscription, payload: ReminderPayload): Promise<'sent' | 'gone'> {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: this.#vapid,
        // Worthless once the meeting has started.
        TTL: 120,
        urgency: 'high',
        // A stalled push service mustn't hold up every other member's reminders.
        timeout: 10_000,
      })
      return 'sent'
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) return 'gone'
      throw err
    }
  }
}

/** Records what would have been sent. For tests and development without VAPID keys. */
export class FakePushSender implements PushSender {
  readonly sent: Array<{ endpoint: string; payload: ReminderPayload }> = []
  readonly gone = new Set<string>()
  /** Endpoints whose push service is failing: send throws, as web-push does on a 5xx. */
  readonly failing = new Set<string>()

  async send(subscription: PushSubscription, payload: ReminderPayload): Promise<'sent' | 'gone'> {
    if (this.gone.has(subscription.endpoint)) return 'gone'
    if (this.failing.has(subscription.endpoint)) throw new Error('push service unavailable')
    this.sent.push({ endpoint: subscription.endpoint, payload })
    return 'sent'
  }
}
