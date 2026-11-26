// Notifications from the server (meeting and task reminders, check-ins, mentions, Briefcast),
// imported into the service worker vite-plugin-pwa generates. The server sends
// { title, body, url, tag }; a click opens that page (docs/PLAN-notification-clicks.md).
//
// A Hotsauce tab that's already open is brought to the front and moves there in-app
// (src/lib/swNavigate.ts), never by a page load, which would end a meeting being recorded in it.
// With no tab, or one Chrome won't bring forward, a new one opens.

const NAVIGATE_MESSAGE = 'hearth:navigate'
/** Addresses the server answers itself, never the app: a tab there can't move in-app. */
const SERVER_PAGES = /^\/(api|ws|downloads|mcp|\.well-known)(\/|$)/

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    return
  }
  if (!data.title) return
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: true,
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openFromNotification(event.notification.data?.url))
})

/** Where a click goes: the notification's page on this site, else Today. */
function pageFor(raw) {
  try {
    const url = new URL(raw || '/', self.location.origin)
    if (url.origin === self.location.origin) return url.href
  } catch {
    // Fall through to the home page.
  }
  return new URL('/', self.location.origin).href
}

/** The open Hotsauce tab to use: the one in front, else one on screen, else the latest. */
function pickTab(windows) {
  const tabs = windows.filter((w) => {
    if (w.frameType === 'nested' || w.frameType === 'auxiliary') return false
    try {
      const url = new URL(w.url)
      return url.origin === self.location.origin && !SERVER_PAGES.test(url.pathname)
    } catch {
      return false
    }
  })
  return (
    tabs.find((w) => w.focused) ||
    tabs.find((w) => w.visibilityState === 'visible') ||
    tabs[0] ||
    null
  )
}

async function openFromNotification(raw) {
  const url = pageFor(raw)
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const tab = pickTab(windows)
  if (tab) {
    // Focus first: Chrome lets a click bring one window forward, and only straight away.
    const focused = await Promise.resolve()
      .then(() => tab.focus())
      .catch(() => null)
    if (focused) {
      focused.postMessage({ type: NAVIGATE_MESSAGE, url })
      return
    }
  }
  // No tab, or Chrome wouldn't bring it forward: a new one.
  await Promise.resolve()
    .then(() => self.clients.openWindow(url))
    .catch(() => null)
}
