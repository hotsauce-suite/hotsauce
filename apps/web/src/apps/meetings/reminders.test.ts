import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { meetingsApi } from '../../api/meetings'
import {
  base64UrlToBytes,
  disableReminders,
  enableReminders,
  forgetRemindersHere,
  reminderState,
} from './reminders'

describe('base64UrlToBytes', () => {
  it('decodes an unpadded URL-safe VAPID key', () => {
    expect([...base64UrlToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
  })
})

const KEY = 'AQID_-8'
const OLD_KEY = 'BAUG'

class FakeSubscription {
  unsubscribed = false
  constructor(
    readonly endpoint: string,
    key: string,
  ) {
    this.options = { applicationServerKey: base64UrlToBytes(key).buffer }
  }
  readonly options: { applicationServerKey: ArrayBuffer }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }
  }
  async unsubscribe() {
    this.unsubscribed = true
    return true
  }
}

let current: FakeSubscription | null
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
    const key = btoa(String.fromCharCode(...applicationServerKey))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    current = new FakeSubscription('https://fcm.googleapis.com/fcm/send/new', key)
    return current
  }),
}

let permission: NotificationPermission
beforeEach(() => {
  current = null
  permission = 'granted'
  pushManager.getSubscription.mockClear()
  pushManager.subscribe.mockClear()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }) },
  })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', {
    get permission() {
      return permission
    },
    requestPermission: async () => permission,
  })
  vi.spyOn(meetingsApi, 'reminderKey').mockResolvedValue({ publicKey: KEY })
  vi.spyOn(meetingsApi, 'subscribeReminders').mockResolvedValue(undefined)
  vi.spyOn(meetingsApi, 'unsubscribeReminders').mockResolvedValue(undefined)
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('reminders in this browser', () => {
  it('is off without a subscription, and tells the server nothing', async () => {
    expect(await reminderState()).toBe('off')
    expect(meetingsApi.subscribeReminders).not.toHaveBeenCalled()
  })

  it('sends a subscribed browser to the server again, so a dropped one comes back', async () => {
    current = new FakeSubscription('https://fcm.googleapis.com/fcm/send/a', KEY)
    expect(await reminderState()).toBe('on')
    expect(meetingsApi.subscribeReminders).toHaveBeenCalledWith(current.toJSON())
    expect(pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('stays on when the server can’t be reached just then', async () => {
    current = new FakeSubscription('https://fcm.googleapis.com/fcm/send/a', KEY)
    vi.mocked(meetingsApi.subscribeReminders).mockRejectedValueOnce(new Error('offline'))
    expect(await reminderState()).toBe('on')
  })

  it('subscribes again when the server’s key changed', async () => {
    const old = new FakeSubscription('https://fcm.googleapis.com/fcm/send/old', OLD_KEY)
    current = old
    expect(await reminderState()).toBe('on')
    expect(old.unsubscribed).toBe(true)
    expect(meetingsApi.unsubscribeReminders).toHaveBeenCalledWith(old.endpoint)
    expect(meetingsApi.subscribeReminders).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' }),
    )
  })

  it('is off when notification permission was reset, and blocked when denied', async () => {
    current = new FakeSubscription('https://fcm.googleapis.com/fcm/send/a', KEY)
    permission = 'default'
    expect(await reminderState()).toBe('off')
    permission = 'denied'
    expect(await reminderState()).toBe('blocked')
    expect(meetingsApi.subscribeReminders).not.toHaveBeenCalled()
  })

  it('turns on with the server’s key', async () => {
    expect(await enableReminders()).toBe('on')
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(KEY),
    })
    expect(meetingsApi.subscribeReminders).toHaveBeenCalledTimes(1)
  })

  it('turning off unsubscribes the browser even if the server can’t be told', async () => {
    const sub = new FakeSubscription('https://fcm.googleapis.com/fcm/send/a', KEY)
    current = sub
    vi.mocked(meetingsApi.unsubscribeReminders).mockRejectedValueOnce(new Error('offline'))
    expect(await disableReminders()).toBe('off')
    expect(sub.unsubscribed).toBe(true)
  })

  it('at sign-out, unsubscribes this browser, and never holds sign-out up for long', async () => {
    const sub = new FakeSubscription('https://fcm.googleapis.com/fcm/send/a', KEY)
    current = sub
    await forgetRemindersHere()
    expect(sub.unsubscribed).toBe(true)
    expect(meetingsApi.unsubscribeReminders).toHaveBeenCalledWith(sub.endpoint)

    const slow = new FakeSubscription('https://fcm.googleapis.com/fcm/send/b', KEY)
    current = slow
    vi.mocked(meetingsApi.unsubscribeReminders).mockReturnValueOnce(new Promise(() => {}))
    const started = Date.now()
    await forgetRemindersHere(20)
    expect(Date.now() - started).toBeLessThan(1_000)
    // The server never answered, but the browser no longer gets the member's reminders.
    expect(slow.unsubscribed).toBe(true)
  })
})
