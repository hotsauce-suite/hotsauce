// Sends www.hotsauce.work to https://hotsauce.work and serves the static pages with security headers.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === 'www.hotsauce.work') {
      url.hostname = 'hotsauce.work'
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    const res = await env.ASSETS.fetch(request)
    const headers = new Headers(res.headers)
    headers.set('x-content-type-options', 'nosniff')
    headers.set('referrer-policy', 'strict-origin-when-cross-origin')
    headers.set('x-frame-options', 'DENY')
    if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000')
    if ((res.ok || res.status === 304) && url.pathname.startsWith('/img/')) {
      headers.set('cache-control', 'public, max-age=86400')
    }
    return new Response(res.body, { status: res.status, headers })
  },
}
