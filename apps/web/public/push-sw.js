// Notifications from the server (meeting and task reminders, check-ins, mentions, Briefcast),
// imported into the service worker vite-plugin-pwa generates. The server sends
// { title, body, url, tag }; a click opens that page (docs/PLAN-notification-clicks.md).
//
// A Hotsauce tab that's already open moves there in-app (src/lib/swNavigate.ts), never by a page
// load, which would end a meeting being recorded in it, and is brought to the front. With no tab,
// a new one opens. Chrome allows one window action (focus or open) per click, so there is no
// second try. Each click logs what it did (chrome://serviceworker-internals).

const NAVIGATE_MESSAGE = 'hearth:navigate'
/** Addresses the server answers itself, never the app: a tab there can't move in-app. */
const SERVER_PAGES = /^\/(api|ws|downloads|mcp|\.well-known|excalidraw|music|fonts)(\/|$)/
/** A file the server sends as it is (an icon, a script), never an app screen. */
const FILE_PAGE = /\.[a-z0-9]+$/i

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
      return (
        url.origin === self.location.origin &&
        !SERVER_PAGES.test(url.pathname) &&
        !FILE_PAGE.test(url.pathname)
      )
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
  if (!tab) {
    // No Hotsauce tab: a new one (Chrome allows one window action per click).
    const opened = await Promise.resolve()
      .then(() => self.clients.openWindow(url))
      .then(() => true)
      .catch(() => false)
    console.info('hotsauce notification click:', { tabs: 0, opened })
    return
  }
  // Move it in-app first, which is always safe, then bring it forward.
  tab.postMessage({ type: NAVIGATE_MESSAGE, url })
  const focused = await Promise.resolve()
    .then(() => tab.focus())
    .then(() => true)
    .catch(() => false)
  console.info('hotsauce notification click:', {
    tabs: windows.length,
    path: new URL(tab.url).pathname,
    focused,
  })
}
