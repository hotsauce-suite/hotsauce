// The setup page and the popup as a person sees them, with Chrome stubbed
// (docs/PLAN-extension-setup.md R1–R6).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const html = (name: string) => readFileSync(path.join(here, '..', 'static', name), 'utf8')

interface Fake {
  store: Record<string, unknown>
  pinned: boolean
  tabUrl: string
  created: string[]
  optionsOpened: number
}

function stubChrome(fake: Fake): void {
  const chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in fake.store ? { [key]: fake.store[key] } : {}),
        set: async (items: Record<string, unknown>) => Object.assign(fake.store, items),
      },
      onChanged: { addListener: () => {} },
    },
    action: {
      getUserSettings: async () => ({ isOnToolbar: fake.pinned }),
      setBadgeText: async () => {},
      getBadgeText: async () => '',
    },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: '⌥⇧H' }] },
    runtime: {
      getManifest: () => ({ version: '0.8.0' }),
      getURL: (p: string) => `chrome-extension://id/${p}`,
      openOptionsPage: async () => {
        fake.optionsOpened += 1
      },
      sendMessage: async () => ({ ok: true }),
    },
    management: { getSelf: async () => ({ installType: 'normal' }) },
    tabs: {
      create: async ({ url }: { url: string }) => {
        fake.created.push(url)
        return {}
      },
      query: async () => [{ id: 7, url: fake.tabUrl, title: 'A call' }],
    },
    permissions: { request: async () => true },
    scripting: {
      unregisterContentScripts: async () => {},
      registerContentScripts: async () => {},
      executeScript: async () => [],
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = chrome
}

function load(name: string): Document {
  const { window, document } = parseHTML(html(name)) as unknown as {
    window: Window & typeof globalThis
    document: Document
  }
  const g = globalThis as unknown as Record<string, unknown>
  g.window = window
  g.document = document
  g.HTMLElement = window.HTMLElement
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  ;(window as unknown as { close: () => void }).close = () => {}
  proto.scrollIntoView ??= () => {}
  proto.focus ??= () => {}
  proto.select ??= () => {}
  return document
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

let fake: Fake
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setInterval'] })
  fake = { store: {}, pinned: false, tabUrl: 'https://example.com/', created: [], optionsOpened: 0 }
  stubChrome(fake)
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/health'))
      return new Response(JSON.stringify({ ok: true, productName: 'Hotsauce' }))
    return new Response('', { status: 404 })
  }) as typeof fetch
})
afterEach(() => {
  vi.useRealTimers()
})

const done = (doc: Document, id: string) => doc.getElementById(`step-${id}`)?.dataset.done

describe('the setup page', () => {
  it('starts with nothing ticked and the connect form open', async () => {
    const doc = load('setup.html')
    await import('./setupPage')
    await settle()
    expect(['connect', 'pin', 'try'].map((id) => done(doc, id))).toEqual([
      'false',
      'false',
      'false',
    ])
    expect(doc.getElementById('server-form')?.hidden).toBe(false)
    expect(doc.getElementById('shortcut')?.textContent).toBe('⌥⇧H')
    expect(doc.getElementById('version')?.textContent).toBe('0.8.0')
    expect(doc.getElementById('updates')?.textContent).toContain('by itself')
  })

  it('ticks each step from what is so, and hides the form once connected', async () => {
    fake.store.server = { url: 'https://hotsauce.acme.com', name: 'Hotsauce' }
    fake.store['tried-meet'] = true
    fake.pinned = true
    const doc = load('setup.html')
    await import('./setupPage')
    await settle()
    expect(['connect', 'pin', 'try'].map((id) => done(doc, id))).toEqual(['true', 'true', 'true'])
    expect(doc.getElementById('server-form')?.hidden).toBe(true)
    expect(doc.getElementById('workspace')?.textContent).toBe('hotsauce.acme.com')
    // Change opens the form again.
    doc.getElementById('change-server')?.dispatchEvent(new window.Event('click'))
    expect(doc.getElementById('server-form')?.hidden).toBe(false)
  })

  it('connects from the form', async () => {
    const doc = load('setup.html')
    await import('./setupPage')
    await settle()
    ;(doc.getElementById('server-url') as HTMLInputElement).value = 'hotsauce.acme.com'
    doc
      .getElementById('server-form')
      ?.dispatchEvent(new window.Event('submit', { cancelable: true }))
    await settle()
    expect(fake.store.server).toEqual({ url: 'https://hotsauce.acme.com', name: 'Hotsauce' })
    expect(done(doc, 'connect')).toBe('true')
  })

  it('opens a test call and Chrome’s shortcut screen', async () => {
    const doc = load('setup.html')
    await import('./setupPage')
    await settle()
    doc.getElementById('test-call')?.dispatchEvent(new window.Event('click'))
    doc.getElementById('change-shortcut')?.dispatchEvent(new window.Event('click'))
    await settle()
    expect(fake.created).toEqual(['https://meet.google.com/new', 'chrome://extensions/shortcuts'])
  })
})

describe('the popup', () => {
  it('on a Meet call shows Take notes and marks the test call as tried', async () => {
    fake.store.server = { url: 'https://hotsauce.acme.com', name: 'Hotsauce' }
    fake.tabUrl = 'https://meet.google.com/abc-defg-hij'
    const doc = load('popup.html')
    await import('./popup')
    await settle()
    expect(doc.getElementById('on-call')?.hidden).toBe(false)
    expect(fake.store['tried-meet']).toBe(true)
  })

  it('links to Settings and How it works', async () => {
    fake.store.server = { url: 'https://hotsauce.acme.com', name: 'Hotsauce' }
    fake.tabUrl = 'chrome://newtab/'
    const doc = load('popup.html')
    await import('./popup')
    await settle()
    expect(doc.getElementById('change-server')?.hidden).toBe(false)
    expect(doc.getElementById('how-it-works')?.getAttribute('href')).toBe(
      'https://hotsauce.work/help/chrome-extension',
    )
    doc.getElementById('open-settings')?.dispatchEvent(new window.Event('click'))
    await settle()
    expect(fake.optionsOpened).toBe(1)
    expect(fake.store['tried-meet']).toBeUndefined()
  })
})
