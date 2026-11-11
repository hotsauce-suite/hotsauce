// Sends www.hotsauce.work to hotsauce.work and serves the static pages.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === 'www.hotsauce.work') {
      url.hostname = 'hotsauce.work'
      return Response.redirect(url.toString(), 301)
    }
    const res = await env.ASSETS.fetch(request)
    const headers = new Headers(res.headers)
    headers.set('x-content-type-options', 'nosniff')
    headers.set('referrer-policy', 'strict-origin-when-cross-origin')
    return new Response(res.body, { status: res.status, headers })
  },
}
