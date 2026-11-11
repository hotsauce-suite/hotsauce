import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_CHUNKS, MAX_TITLE_LENGTH } from '../clips/index.js'
import { HearthError } from '../errors.js'
import { contentDisposition } from '../meetings/audio/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const ClipId = z.string().regex(/^[0-9A-Z]{26}$/)

/** Hearth Clips' locally stored media: the path every request to it starts with. */
export const CLIP_MEDIA_PREFIX = '/api/clips/media/'

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`; null for anything else (whole file). */
export function parseRange(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match || size === 0) return null
  const [, a = '', b = ''] = match
  if (a === '' && b === '') return null
  let start: number
  let end: number
  if (a === '') {
    start = Math.max(0, size - Number(b))
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start > end || start >= size) return 'unsatisfiable' as const
  return { start, end }
}

/**
 * Hearth Clips (ARCHITECTURE §10.2). Any member can list and watch clips; only the owner sends a
 * recording's chunks, finishes, renames, deletes or retries it. `/media/...` is reached without a
 * session: its URLs carry their own short-lived signature (the middleware lets them through).
 */
export function clipRoutes(deps: AppDeps) {
  const { clips } = deps
  return new Hono<AppEnv>()
    .basePath('/clips')
    .get('/config', (c) => c.json({ available: clips.available }))
    .get(
      '/',
      valid(
        'query',
        z.object({
          scope: z.enum(['mine', 'team']).default('mine'),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      ),
      async (c) => c.json({ clips: await clips.list(c.get('principal'), c.req.valid('query')) }),
    )
    .post(
      '/',
      valid(
        'json',
        z.object({
          mode: z.enum(['screen_camera', 'screen', 'camera']),
          container: z.enum(['mp4', 'webm']),
          title: z.string().max(MAX_TITLE_LENGTH).optional(),
        }),
      ),
      async (c) => c.json(await clips.create(c.get('principal'), c.req.valid('json')), 201),
    )
    .get('/media/:id/:file', async (c) => {
      const query = z
        .object({
          exp: z.coerce.number().int(),
          sig: z.string().min(1).max(100),
          download: z.string().max(300).optional(),
        })
        .safeParse(c.req.query())
      if (!query.success) throw new HearthError('not_found', 'No such file')
      const media = await clips.localMedia({
        id: c.req.param('id'),
        file: c.req.param('file'),
        ...query.data,
      })
      const headers: Record<string, string> = {
        'Content-Type': media.contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      }
      if (media.download) headers['Content-Disposition'] = contentDisposition(media.download)
      const range = parseRange(c.req.header('range'), media.size)
      if (range === 'unsatisfiable') {
        return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${media.size}` })
      }
      const { start, end } = range ?? { start: 0, end: media.size - 1 }
      const body = Readable.toWeb(createReadStream(media.path, { start, end }))
      headers['Content-Length'] = String(end - start + 1)
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${media.size}`
      return c.body(body as ReadableStream<Uint8Array>, range ? 206 : 200, headers)
    })
    .get('/:id', valid('param', z.object({ id: ClipId })), async (c) => {
      c.header('Cache-Control', 'no-store')
      return c.json(await clips.get(c.get('principal'), c.req.valid('param').id))
    })
    .patch(
      '/:id',
      valid('param', z.object({ id: ClipId })),
      valid('json', z.object({ title: z.string().max(MAX_TITLE_LENGTH) })),
      async (c) =>
        c.json(
          await clips.rename(
            c.get('principal'),
            c.req.valid('param').id,
            c.req.valid('json').title,
          ),
        ),
    )
    .delete('/:id', valid('param', z.object({ id: ClipId })), async (c) => {
      await clips.delete(c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .put(
      '/:id/chunks/:seq',
      valid(
        'param',
        z.object({
          id: ClipId,
          seq: z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_CHUNKS - 1),
        }),
      ),
      async (c) => {
        const { id, seq } = c.req.valid('param')
        await clips.putChunk(c.get('principal'), id, seq, new Uint8Array(await c.req.arrayBuffer()))
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/finish',
      valid('param', z.object({ id: ClipId })),
      valid('json', z.object({ chunks: z.number().int().min(1).max(MAX_CHUNKS) })),
      async (c) =>
        c.json(
          await clips.finish(
            c.get('principal'),
            c.req.valid('param').id,
            c.req.valid('json').chunks,
          ),
        ),
    )
    .post('/:id/transcript/retry', valid('param', z.object({ id: ClipId })), async (c) =>
      c.json(await clips.retryTranscript(c.get('principal'), c.req.valid('param').id)),
    )
}
