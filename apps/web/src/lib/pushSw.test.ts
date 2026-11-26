// The service worker's notification clicks (public/push-sw.js, docs/PLAN-notification-clicks.md),
// run against a fake worker scope: which tab a click uses, and what happens when it can't move.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://hotsauce.example'
const source = readFileSync(join(__dirname, '../../public/push-sw.js'), 'utf8')

interface FakeTab {
  id: string
  url: string
  focused?: boolean
  visibilityState?: 'visible' | 'hidden'
  frameType?: 'top-level' | 'nested' | 'auxiliary'
  focusFails?: boolean
  focus: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}

function tab(id: string, path: string, opts: Partial<FakeTab> = {}): FakeTab {
  const t: FakeTab = {
    id,
    url: ORIGIN + path,
    frameType: 'top-level',
    visibilityState: 'hidden',
    ...opts,
    focus: vi.fn(),
    navigate: vi.fn(),
    postMessage: vi.fn(),
  }
  t.focus.mockImplementation(async () => {
    if (t.focusFails) throw new Error('Not allowed to focus a window.')
    return t
  })
  t.navigate.mockImplementation(async (url: string) => {
    t.url = url
    return t
  })
  t.postMessage.mockImplementation((data: { url: string }) => {
    t.url = data.url
  })
  return t
}

function worker(tabs: FakeTab[], opts: { openFails?: boolean } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const opened: string[] = []
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn
    },
    registration: { showNotification: vi.fn(async () => {}) },
    clients: {
      matchAll: vi.fn(async () => tabs),
      openWindow: vi.fn(async (url: string) => {
        if (opts.openFails) throw new Error('Not allowed to open a window.')
        opened.push(url)
        return null
      }),
    },
  }
  new Function('self', source)(self)

  async function click(url: string | undefined) {
    let done: Promise<unknown> = Promise.resolve()
    const close = vi.fn()
    listeners.notificationclick?.({
      notification: { close, data: url === undefined ? undefined : { url } },
      waitUntil: (p: Promise<unknown>) => {
        done = p
      },
    })
    await done
    return { close }
  }

  async function push(data: unknown) {
    let done: Promise<unknown> = Promise.resolve()
    listeners.push?.({
      data: { json: () => data },
      waitUntil: (p: Promise<unknown>) => {
        done = p
      },
    })
    await done
  }

  return { self, opened, click, push }
}

describe('a click on a notification', () => {
  it('opens its page in a new tab when Hotsauce isn’t open', async () => {
    const w = worker([])
    const { close } = await w.click('/briefcast')
    expect(close).toHaveBeenCalled()
    expect(w.opened).toEqual([`${ORIGIN}/briefcast`])
  })

  it('brings an open Hotsauce tab forward and moves it there in-app', async () => {
    const today = tab('a', '/today')
    const w = worker([today])
    await w.click('/briefcast')
    expect(today.focus).toHaveBeenCalled()
    expect(today.postMessage).toHaveBeenCalledWith({
      type: 'hearth:navigate',
      url: `${ORIGIN}/briefcast`,
    })
    expect(today.navigate).not.toHaveBeenCalled()
    expect(w.opened).toEqual([])
  })

  it('uses the tab in front, then one on screen, before older ones', async () => {
    const old = tab('a', '/sign-in')
    const onScreen = tab('b', '/docs', { visibilityState: 'visible' })
    const front = tab('c', '/today', { focused: true, visibilityState: 'visible' })
    await worker([old, onScreen, front]).click('/briefcast')
    expect(front.focus).toHaveBeenCalled()
    expect(old.focus).not.toHaveBeenCalled()
    expect(onScreen.focus).not.toHaveBeenCalled()

    const old2 = tab('a', '/sign-in')
    const onScreen2 = tab('b', '/docs', { visibilityState: 'visible' })
    await worker([old2, onScreen2]).click('/briefcast')
    expect(onScreen2.focus).toHaveBeenCalled()
    expect(old2.focus).not.toHaveBeenCalled()
  })

  it('skips frames inside a page and pages the server answers itself', async () => {
    const frame = tab('a', '/api/files/x.pdf', { frameType: 'nested', focused: true })
    const raw = tab('b', '/api/briefcast/feed', { visibilityState: 'visible' })
    const mcp = tab('c', '/mcp/authorize')
    const w = worker([frame, raw, mcp])
    await w.click('/briefcast')
    for (const t of [frame, raw, mcp]) expect(t.focus).not.toHaveBeenCalled()
    expect(w.opened).toEqual([`${ORIGIN}/briefcast`])
  })

  it('still moves the open tab when Chrome won’t bring it forward', async () => {
    const hidden = tab('a', '/today', { focusFails: true })
    const w = worker([hidden])
    await w.click('/tasks/today')
    expect(hidden.postMessage).toHaveBeenCalledWith({
      type: 'hearth:navigate',
      url: `${ORIGIN}/tasks/today`,
    })
    expect(hidden.navigate).not.toHaveBeenCalled()
  })

  it('skips a tab showing a file, like an icon opened directly', async () => {
    const icon = tab('a', '/icon-192.png', { focused: true })
    const w = worker([icon])
    await w.click('/briefcast')
    expect(icon.focus).not.toHaveBeenCalled()
    expect(w.opened).toEqual([`${ORIGIN}/briefcast`])
  })

  it('never leaves the site, and goes home without a page', async () => {
    const w = worker([])
    await w.click('https://evil.example/phish')
    await w.click(undefined)
    expect(w.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`])
  })

  it('does not throw when the browser refuses a new tab', async () => {
    await expect(worker([], { openFails: true }).click('/briefcast')).resolves.toBeDefined()
  })
})

describe('a push', () => {
  it('shows the notification with its page for the click', async () => {
    const w = worker([])
    await w.push({
      title: 'Your Briefcast is ready',
      body: 'Briefcast for Thursday',
      url: '/briefcast',
      tag: 'briefcast-2026-11-26',
    })
    expect(w.self.registration.showNotification).toHaveBeenCalledWith(
      'Your Briefcast is ready',
      expect.objectContaining({ tag: 'briefcast-2026-11-26', data: { url: '/briefcast' } }),
    )
  })
})
