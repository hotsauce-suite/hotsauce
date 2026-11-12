import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  CHUNK_BYTES,
  type Files,
  type FileView,
  type LocalMedia,
  MAX_CHUNKS,
} from '../files/index.js'
import { contentDisposition } from '../meetings/audio/index.js'
import { parseRange } from './clips.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Id = z.string().regex(/^[0-9A-Z]{26}$/)
const SpaceId = z.object({ space: z.string().min(1).max(100), id: Id })
const Token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
const Name = z.string().min(1).max(400)
const Folder = z.string().max(2000)

/** Hearth Files (ARCHITECTURE §18.2). Spaces are checked in the service, as for Notes. */
export function driveRoutes(deps: AppDeps) {
  const { files } = deps
  const view = (v: FileView) => withUrls(files, v)
  return new Hono<AppEnv>()
    .basePath('/files')
    .get('/config', (c) =>
      c.json({
        available: files.available,
        chunkBytes: CHUNK_BYTES,
        maxBytes: CHUNK_BYTES * MAX_CHUNKS,
      }),
    )
    .get(
      '/',
      valid(
        'query',
        z.object({
          space: z.string().min(1).optional(),
          folder: Folder.optional(),
          q: z.string().max(200).optional(),
        }),
      ),
      async (c) => {
        const listing = await files.list(c.get('principal'), c.req.valid('query'))
        c.header('Cache-Control', 'no-store')
        return c.json({ ...listing, files: await Promise.all(listing.files.map(view)) })
      },
    )
    .get('/recent', async (c) => {
      c.header('Cache-Control', 'no-store')
      return c.json({
        files: await Promise.all((await files.recent(c.get('principal'))).map(view)),
      })
    })
    .post(
      '/uploads',
      valid(
        'json',
        z.object({
          space: z.string().min(1),
          folder: Folder.optional(),
          name: Name,
          size: z.number().int().min(0),
          mime: z.string().max(200).optional(),
        }),
      ),
      async (c) => c.json(await files.startUpload(c.get('principal'), c.req.valid('json')), 201),
    )
    .put(
      '/uploads/:id/chunks/:seq',
      valid(
        'param',
        z.object({
          id: Id,
          seq: z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_CHUNKS - 1),
        }),
      ),
      async (c) => {
        const { id, seq } = c.req.valid('param')
        await files.putChunk(c.get('principal'), id, seq, new Uint8Array(await c.req.arrayBuffer()))
        return c.body(null, 204)
      },
    )
    .post('/uploads/:id/complete', valid('param', z.object({ id: Id })), async (c) => {
      const principal = c.get('principal')
      return c.json(
        await view(
          await files.completeUpload(principal, c.req.valid('param').id, viaFor(principal)),
        ),
      )
    })
    .delete('/uploads/:id', valid('param', z.object({ id: Id })), async (c) => {
      await files.cancelUpload(c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post(
      '/folders',
      valid('json', z.object({ space: z.string().min(1), folder: Folder.min(1) })),
      async (c) => {
        const { space, folder } = c.req.valid('json')
        const principal = c.get('principal')
        return c.json(await files.createFolder(principal, space, folder, viaFor(principal)), 201)
      },
    )
    .patch(
      '/folders',
      valid('json', z.object({ space: z.string().min(1), from: Folder.min(1), to: Folder.min(1) })),
      async (c) => {
        const { space, from, to } = c.req.valid('json')
        const principal = c.get('principal')
        return c.json(await files.renameFolder(principal, space, from, to, viaFor(principal)))
      },
    )
    .delete(
      '/folders',
      valid('json', z.object({ space: z.string().min(1), folder: Folder.min(1) })),
      async (c) => {
        const { space, folder } = c.req.valid('json')
        const principal = c.get('principal')
        await files.removeFolder(principal, space, folder, viaFor(principal))
        return c.body(null, 204)
      },
    )
    .get('/shared/:token', valid('param', z.object({ token: Token })), async (c) => {
      const v = await files.shared(c.req.valid('param').token)
      c.header('Cache-Control', 'no-store')
      // Someone holding the link sees this file only: never where it sits or the owner's space.
      return c.json({ ...sharedView(v), ...(await files.urls(v)) })
    })
    .get(
      '/media/:space/:id',
      valid('param', SpaceId),
      valid(
        'query',
        z.object({
          exp: z.coerce.number().int(),
          sig: z.string().min(1).max(100),
          download: z.string().optional(),
        }),
      ),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const q = c.req.valid('query')
        return send(
          c,
          await files.localMedia({
            space,
            id,
            exp: q.exp,
            sig: q.sig,
            download: q.download !== undefined,
          }),
        )
      },
    )
    .get(
      '/item/:space/:id',
      valid('param', SpaceId),
      valid('query', z.object({ text: z.string().optional() })),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const principal = c.get('principal')
        const v = await view(await files.get(principal, space, id))
        c.header('Cache-Control', 'no-store')
        if (c.req.valid('query').text === undefined) return c.json(v)
        return c.json({ ...v, text: await files.text(principal, space, id) })
      },
    )
    .patch(
      '/item/:space/:id',
      valid('param', SpaceId),
      valid('json', z.object({ name: Name.optional(), folder: Folder.optional() })),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const principal = c.get('principal')
        return c.json(
          await view(
            await files.update(principal, space, id, c.req.valid('json'), viaFor(principal)),
          ),
        )
      },
    )
    .post(
      '/item/:space/:id/share',
      valid('param', SpaceId),
      valid('json', z.object({ on: z.boolean() })),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const principal = c.get('principal')
        const v = await files.setShared(
          principal,
          space,
          id,
          c.req.valid('json').on,
          viaFor(principal),
        )
        return c.json(await view(v))
      },
    )
    .post(
      '/item/:space/:id/move',
      valid('param', SpaceId),
      valid('json', z.object({ to: z.string().min(1) })),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const principal = c.get('principal')
        return c.json(
          await view(
            await files.moveSpace(principal, space, id, c.req.valid('json').to, viaFor(principal)),
          ),
        )
      },
    )
    .delete('/item/:space/:id', valid('param', SpaceId), async (c) => {
      const { space, id } = c.req.valid('param')
      const principal = c.get('principal')
      await files.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}

/** The file plus where the web app opens it and where its bytes are. */
export async function withUrls(files: Files, v: FileView) {
  const { key: _key, ...rest } = v
  return {
    ...rest,
    url: `/files/${encodeURIComponent(v.space)}/${v.id}`,
    shareUrl: v.shareToken ? `/files/s/${v.shareToken}` : null,
    ...(await files.urls(v)),
  }
}

function sharedView(v: FileView) {
  return {
    id: v.id,
    name: v.name,
    size: v.size,
    mime: v.mime,
    preview: v.preview,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    updatedAt: v.updatedAt,
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Hono's context type varies by route
function send(c: any, target: LocalMedia): Response {
  const headers: Record<string, string> = {
    'Content-Type': target.inline ? target.mime : 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': target.inline ? 'inline' : contentDisposition(target.name),
    // A file may be framed by Hearth's own preview, never elsewhere. Anything but a PDF (which
    // Chrome won't show sandboxed) gets a sandbox, so nothing it holds runs in Hearth's origin.
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy':
      target.inline && target.mime === 'application/pdf'
        ? "frame-ancestors 'self'"
        : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  }
  const range = parseRange(c.req.header('range'), target.size)
  if (range === 'unsatisfiable') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${target.size}` })
  }
  const { start, end } = range ?? { start: 0, end: Math.max(0, target.size - 1) }
  headers['Content-Length'] = String(target.size === 0 ? 0 : end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${target.size}`
  if (target.size === 0) return c.body(new Uint8Array(), 200, headers)
  const body = Readable.toWeb(createReadStream(target.path, { start, end }))
  return c.body(body as ReadableStream<Uint8Array>, range ? 206 : 200, headers)
}
