// "Remind me before meetings" (PRD §6.1): this browser's push subscription, kept in step with the
// server. Push needs a service worker, so it works in the built app, not under `pnpm dev`; on
// iPhone and iPad only once Hearth is added to the Home Screen.

import { meetingsApi } from '../../api/meetings'

export type ReminderState = 'unsupported' | 'unavailable' | 'blocked' | 'off' | 'on'

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

/**
 * Whether this browser gets reminders. A subscribed browser is sent to the server again each
 * time, which heals what can drift: the server dropped it (the push service replaced it), another
 * member used this browser last, or the server's key changed.
 */
export async function reminderState(): Promise<ReminderState> {
  const reg = pushSupported() ? await registration() : null
  if (!reg) return 'unsupported'
  const { publicKey } = await meetingsApi.reminderKey()
  if (!publicKey) return 'unavailable'
  if (Notification.permission === 'denied') return 'blocked'
  const existing = await reg.pushManager.getSubscription()
  if (!existing || Notification.permission !== 'granted') return 'off'
  const sub = await subscription(reg, publicKey, existing)
  // A failure here leaves the server as it was; the next visit tries again.
  await meetingsApi.subscribeReminders(sub.toJSON()).catch(() => {})
  return 'on'
}

export async function enableReminders(): Promise<ReminderState> {
  const reg = await registration()
  const { publicKey } = await meetingsApi.reminderKey()
  if (!reg || !publicKey) return 'unavailable'
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked'
  const sub = await subscription(reg, publicKey, await reg.pushManager.getSubscription())
  await meetingsApi.subscribeReminders(sub.toJSON())
  return 'on'
}

export async function disableReminders(): Promise<ReminderState> {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (sub) {
    // The browser first: once it's unsubscribed, its push service refuses the endpoint, and the
    // server forgets it at the next reminder even if this request doesn't get through.
    const { endpoint } = sub
    await sub.unsubscribe()
    await meetingsApi.unsubscribeReminders(endpoint).catch(() => {})
  }
  return 'off'
}

/**
 * At sign-out: this browser stops getting the member's reminders, so whoever uses it next
 * doesn't see their meetings. Gives up after a moment rather than hold up signing out.
 */
export async function forgetRemindersHere(waitMs = 2_000): Promise<void> {
  if (!pushSupported()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    disableReminders().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
  clearTimeout(timer)
}

/** `existing` when it was made with the server's key, else a new subscription that is. */
async function subscription(
  reg: ServiceWorkerRegistration,
  publicKey: string,
  existing: PushSubscription | null,
): Promise<PushSubscription> {
  const key = base64UrlToBytes(publicKey)
  if (existing && sameBytes(existing.options.applicationServerKey, key)) return existing
  if (existing) {
    await existing.unsubscribe()
    await meetingsApi.unsubscribeReminders(existing.endpoint).catch(() => {})
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  // A browser that doesn't report the key: assume it's the one it was made with.
  if (!a) return true
  const bytes = new Uint8Array(a)
  return bytes.length === b.length && bytes.every((v, i) => v === b[i])
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
