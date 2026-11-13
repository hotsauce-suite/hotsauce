import type { MiddlewareHandler } from 'hono'

// Addresses the instance used to live at (LEGACY_HOSTS). Pages opened there move to the same path
// on PUBLIC_URL, so old links keep working. The API, sockets, MCP and downloads keep answering on
// the old address, because installed apps (the Mac app, a Chrome extension) still call it.
const KEEP = ['/api/', '/ws', '/mcp', '/downloads/', '/.well-known/']

export function legacyHostRedirect(publicUrl: string, hosts: readonly string[]): MiddlewareHandler {
  const old = new Set(hosts.map((h) => h.toLowerCase()))
  const base = publicUrl.replace(/\/+$/, '')
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '')
    const method = c.req.method
    const path = c.req.path
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
