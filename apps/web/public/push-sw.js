// Meeting reminders (PRD §6.1), imported into the service worker vite-plugin-pwa generates.
// The server sends { title, body, url, tag }; a click opens Start for that event. A Hearth tab
// that's already open moves there in-app (src/lib/swNavigate.ts), never by a page load, which
// would end a meeting being recorded in it.

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
      data: { url: data.url || '/meetings' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/meetings', self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        open.postMessage({ type: 'hearth:navigate', url })
        await open.focus().catch(() => {})
      } else {
        await self.clients.openWindow(url)
      }
    })(),
  )
})
