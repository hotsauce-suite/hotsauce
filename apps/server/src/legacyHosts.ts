import type { MiddlewareHandler } from 'hono'

// Addresses the instance used to live at (LEGACY_HOSTS). Pages opened there move to the same path
// on PUBLIC_URL, so old links keep working. The API, sockets, MCP and downloads keep answering on
// the old address, because installed apps (the Mac app, a Chrome extension) still call it.
const KEEP = ['/api/', '/ws', '/mcp', '/downloads/', '/.well-known/']

/**
 * What a browser that installed the web app on an old address gets when it checks for a new
 * service worker: one that empties the old copy's caches, unregisters itself and reloads each
 * open tab at the same page on the current address. (A redirect here would fail the update and
 * leave the old copy running.)
 */
export function retiringServiceWorker(publicUrl: string): string {
  const base = JSON.stringify(publicUrl.replace(/\/+$/, ''))
  return `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of tabs) {
      const url = new URL(client.url)
      client.navigate(${base} + url.pathname + url.search)
    }
  })())
})
`
}

export function legacyHostRedirect(publicUrl: string, hosts: readonly string[]): MiddlewareHandler {
  const old = new Set(hosts.map((h) => h.toLowerCase()))
  const base = publicUrl.replace(/\/+$/, '')
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '')
    const method = c.req.method
    const path = c.req.path
    if (old.has(host) && path === '/sw.js') {
      c.header('Cache-Control', 'no-cache')
      return c.body(retiringServiceWorker(publicUrl), 200, { 'Content-Type': 'text/javascript' })
    }
    if (
      old.size === 0 ||
      !old.has(host) ||
      (method !== 'GET' && method !== 'HEAD') ||
      path === '/api' ||
      KEEP.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))
    ) {
      return next()
    }
    const url = new URL(c.req.url)
    return c.redirect(`${base}${url.pathname}${url.search}`, 301)
  }
}
