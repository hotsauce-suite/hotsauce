import { assetPath, newId } from '@hearth/format'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { formatCommitMessage } from '../git/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import { afterCommit } from './save.js'
import { PathParam, valid } from './validate.js'

export const MAX_ASSET_BYTES = 10 * 1024 * 1024
// Room for the multipart boundaries and headers around the file itself.
const MAX_UPLOAD_BYTES = MAX_ASSET_BYTES + 64 * 1024

function tooLarge(): never {
  throw new HearthError('bad_request', 'Files are limited to 10 MB', { status: 413 })
}

// Types a browser may render inline. Anything else is served as a download.
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

export function assetRoutes(deps: AppDeps) {
  const { git } = deps
  return new Hono<AppEnv>()
    .basePath('/spaces/:space')
    .post('/assets', bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: tooLarge }), async (c) => {
      const space = c.req.param('space')
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) {
        throw new HearthError('bad_request', 'Send the upload as multipart form field "file"')
      }
      if (file.size > MAX_ASSET_BYTES) tooLarge()
      const path = assetPath(file.name, new Date(), newId())
      const name = file.name.replace(/\s+/g, ' ').trim()
      const result = await git.commit(space, {
        changes: [{ path, content: new Uint8Array(await file.arrayBuffer()) }],
        author: authorOf(c.get('principal')),
        message: formatCommitMessage({ app: 'docs', verb: 'add asset', title: name }),
      })
      await afterCommit(deps, space, path, result)
      return c.json({ path })
    })
    .get('/raw', valid('query', z.object({ path: PathParam })), async (c) => {
      const { path } = c.req.valid('query')
      const { content, blobOid } = await git.readBlob(c.req.param('space'), path)
      // The blob id is the content's hash, so a matching ETag means the bytes are unchanged. The
      // URL names a path, whose bytes can change, so the browser revalidates every time (a 304).
      const etag = `"${blobOid}"`
      const headers: Record<string, string> = {
        ETag: etag,
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
        // Files come from the repo, which anyone with push access can write: never let one
        // run script in Hearth's origin (an SVG opened directly, say).
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      }
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      const type = INLINE_TYPES[ext]
      headers['Content-Type'] = type ?? 'application/octet-stream'
      if (type === undefined) headers['Content-Disposition'] = 'attachment'
      return c.body(new Uint8Array(content), 200, headers)
    })
}
