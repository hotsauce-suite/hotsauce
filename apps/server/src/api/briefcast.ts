import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { parseRange } from './clips.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

/** The private podcast feed and its audio: reached without a session (the token is the key). */
export const BRIEFCAST_FEED_PREFIX = '/api/briefcast/feed/'

const Zone = z.string().min(1).max(100).optional()
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

/** Briefcast (docs/plans/2026-11-12-briefcast.md): the member's own morning briefings. */
export function briefcastRoutes(deps: Pick<AppDeps, 'briefcasts'>) {
  const { briefcasts } = deps
  return (
    new Hono<AppEnv>()
      .basePath('/briefcast')
      /** Episodes, the newest in full, the feed URL; `tz` enrols the member for mornings. */
      .get('/', valid('query', z.object({ tz: Zone })), async (c) => {
        const principal = c.get('principal')
        await briefcasts.touch(principal, c.req.valid('query').tz)
        return c.json(await briefcasts.overview(principal))
      })
      /** Makes today's episode now, even if one exists. */
      .post('/refresh', valid('json', z.object({ tz: Zone }).default({})), async (c) => {
        const principal = c.get('principal')
        await briefcasts.touch(principal, c.req.valid('json').tz)
        const via = viaFor(principal)
        return c.json(await briefcasts.refresh(principal, { force: true, ...(via ? { via } : {}) }))
      })
      .get('/episodes/:date', valid('param', z.object({ date: Day })), async (c) => {
        return c.json(await briefcasts.episode(c.get('principal'), c.req.valid('param').date))
      })
      .get('/episodes/:date/audio', valid('param', z.object({ date: Day })), async (c) => {
        const bytes = await briefcasts.audio(c.get('principal'), c.req.valid('param').date)
        return mp3(c.req.header('range'), bytes, 'private, no-cache')
      })
      /** A new private feed URL; any earlier one stops working. */
      .post('/feed', async (c) =>
        c.json({ feedUrl: await briefcasts.makeFeed(c.get('principal')) }),
      )
      .delete('/feed', async (c) => {
        await briefcasts.removeFeed(c.get('principal'))
        return c.body(null, 204)
      })
      .get('/feed/:file', async (c) => {
        const match = /^(.+)\.xml$/.exec(c.req.param('file'))
        const token = Token.safeParse(match?.[1])
        if (!token.success) throw new HearthError('not_found', 'No such feed')
        const body = await briefcasts.feed(token.data)
        return c.body(body, 200, {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=300',
          'X-Robots-Tag': 'noindex',
        })
      })
      .get('/feed/:token/:file', async (c) => {
        const token = Token.safeParse(c.req.param('token'))
        const match = /^(\d{4}-\d{2}-\d{2})\.mp3$/.exec(c.req.param('file'))
        if (!token.success || !match?.[1]) throw new HearthError('not_found', 'No such episode')
        const bytes = await briefcasts.feedAudio(token.data, match[1])
        return mp3(c.req.header('range'), bytes, 'private, max-age=86400')
      })
  )
}

/** The MP3 with byte ranges: Safari and podcast apps seek with them. */
function mp3(rangeHeader: string | undefined, bytes: Uint8Array, cache: string): Response {
  const size = bytes.length
  const headers: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  }
  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    })
  }
  if (range) {
    const part = bytes.slice(range.start, range.end + 1)
    return new Response(Buffer.from(part), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(part.length),
      },
    })
  }
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}
