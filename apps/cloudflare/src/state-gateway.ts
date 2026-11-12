/**
 * The state store the server's mirror talks to (apps/server/src/state/remote.ts), answered from
 * an R2 bucket. The container reaches it at http://state.hotsauce through an outbound intercept,
 * so it holds no R2 keys. Every key lives under `state/`, beside whatever else the bucket keeps.
 *
 *   GET    /list      → {"keys": [...]}
 *   GET    /o/<key>   → body, or 404
 *   PUT    /o/<key>   → 204
 *   DELETE /o/<key>   → 204
 */

/** The parts of an R2 bucket this uses, so tests can pass a stand-in. */
export interface StateBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, value: ArrayBuffer): Promise<unknown>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
}

export const PREFIX = 'state/'

/** A key the server may use: a relative path with no empty, `.` or `..` segment. */
function keyOf(pathname: string): string | null {
  if (!pathname.startsWith('/o/')) return null
  let key: string
  try {
    key = pathname.slice(3).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  const parts = key.split('/')
  if (key.length === 0 || key.length > 512) return null
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) return null
  return key
}

export async function handleState(request: Request, bucket: StateBucket): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/list' && request.method === 'GET') {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await bucket.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) })
      for (const o of page.objects) keys.push(o.key.slice(PREFIX.length))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return Response.json({ keys })
  }
  const key = keyOf(url.pathname)
  if (!key) return new Response('Not found', { status: 404 })
  switch (request.method) {
    case 'GET': {
      const object = await bucket.get(PREFIX + key)
      if (!object) return new Response('Not found', { status: 404 })
      return new Response(await object.arrayBuffer())
    }
    case 'PUT':
      await bucket.put(PREFIX + key, await request.arrayBuffer())
      return new Response(null, { status: 204 })
    case 'DELETE':
      await bucket.delete(PREFIX + key)
      return new Response(null, { status: 204 })
    default:
      return new Response('Method not allowed', { status: 405 })
  }
}
