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
    if ((res.ok || res.status === 304) && (url.pathname.startsWith('/img/') || url.pathname.startsWith('/video/'))) {
      headers.set('cache-control', 'public, max-age=86400')
    }
    // Safari only plays video served in byte ranges; answer a Range request with a 206 slice.
    const range = request.headers.get('range')
    if (request.method === 'GET' && res.status === 200 && range && url.pathname.startsWith('/video/')) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      const buf = await res.arrayBuffer()
      const size = buf.byteLength
      let start = m && m[1] !== '' ? Number(m[1]) : NaN
      let end = m && m[2] !== '' ? Number(m[2]) : size - 1
      if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1 }
      if (!m || Number.isNaN(start) || start >= size || end < start) {
        headers.set('content-range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }
      end = Math.min(end, size - 1)
      headers.set('content-range', `bytes ${start}-${end}/${size}`)
      headers.set('content-length', String(end - start + 1))
      headers.set('accept-ranges', 'bytes')
      return new Response(buf.slice(start, end + 1), { status: 206, headers })
    }
    if (url.pathname.startsWith('/video/')) headers.set('accept-ranges', 'bytes')
    return new Response(res.body, { status: res.status, headers })
  },
}
