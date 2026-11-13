import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { patchFrontmatter } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { clipNote, freePath, MAX_CHUNKS, MAX_TITLE_LENGTH, speakersOf } from '../clips/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, withVia } from '../git/index.js'
import { contentDisposition } from '../meetings/audio/index.js'
import { type AppDeps, type AppEnv, authorOf } from './env.js'
import { afterCommit, saveFile } from './save.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const ClipId = z.string().regex(/^[0-9A-Z]{26}$/)

/** Sends into one space run one at a time, so two picks of the same free path can't both write. */
const sending = new Map<string, Promise<unknown>>()
function oneAtATime<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (sending.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
  sending.set(key, run)
  void run
    .finally(() => {
      if (sending.get(key) === run) sending.delete(key)
    })
    .catch(() => {})
  return run
}

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
  return (
    new Hono<AppEnv>()
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
        valid(
          'json',
          z
            .object({
              title: z
                .string()
                .max(MAX_TITLE_LENGTH)
                .refine((t) => t.trim() !== '', 'a title can’t be empty')
                .optional(),
              /** Speaker number → name; an empty name goes back to the default. */
              speakers: z.record(z.string().regex(/^\d{1,3}$/), z.string().max(200)).optional(),
            })
            .refine((b) => b.title !== undefined || b.speakers !== undefined, 'nothing to change'),
        ),
        async (c) => {
          const principal = c.get('principal')
          const { id } = c.req.valid('param')
          const body = c.req.valid('json')
          // Speakers first: they're the part that can be refused, so nothing is half applied.
          let view = body.speakers ? await clips.setSpeakers(principal, id, body.speakers) : null
          if (body.title !== undefined) view = await clips.rename(principal, id, body.title)
          return c.json(view)
        },
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
        valid('query', z.object({ track: z.enum(['screen', 'camera']).default('screen') })),
        async (c) => {
          const { id, seq } = c.req.valid('param')
          const bytes = new Uint8Array(await c.req.arrayBuffer())
          await clips.putChunk(c.get('principal'), id, seq, bytes, c.req.valid('query').track)
          return c.body(null, 204)
        },
      )
      .post(
        '/:id/finish',
        valid('param', z.object({ id: ClipId })),
        valid(
          'json',
          z.object({
            chunks: z.number().int().min(1).max(MAX_CHUNKS),
            camera: z
              .object({
                chunks: z.number().int().min(0).max(MAX_CHUNKS),
                container: z.enum(['mp4', 'webm']),
                offsetMs: z.number().min(-60_000).max(60_000),
              })
              .optional(),
            screenSurface: z.string().max(40).optional(),
            screenLabel: z.string().max(500).optional(),
          }),
        ),
        async (c) =>
          c.json(
            await clips.finish(c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
          ),
      )
      .post(
        '/:id/ai',
        valid('param', z.object({ id: ClipId })),
        valid('json', z.object({ kind: z.enum(['summary', 'actions']) })),
        async (c) =>
          c.json(
            await clips.generate(
              c.get('principal'),
              c.req.valid('param').id,
              c.req.valid('json').kind,
            ),
          ),
      )
      /** A note about the clip in the member's own space (else the team's), committed as them. */
      .post(
        '/:id/send',
        valid('param', z.object({ id: ClipId })),
        valid(
          'json',
          z.object({ to: z.enum(['doc', 'meeting']), transcript: z.boolean().default(false) }),
        ),
        async (c) => {
          const principal = c.get('principal')
          const { to, transcript } = c.req.valid('json')
          const clip = clips.record(principal, c.req.valid('param').id)
          if (clip.status !== 'ready')
            throw new HearthError('conflict', 'This clip isn’t ready yet')
          const spaces = await deps.spaces.visibleSpaces(principal)
          const space = (spaces.find((s) => s.kind === 'personal') ?? spaces[0])?.name
          if (!space) throw new HearthError('forbidden', 'You have no space to write to')
          const url = `${deps.config.PUBLIC_URL.replace(/\/+$/, '')}/clips/${clip.id}`
          const note = clipNote({
            kind: to,
            clip,
            speakers: speakersOf(clip),
            url,
            withTranscript: transcript,
            now: new Date(),
          })
          return oneAtATime(space, async () => {
            const exists = (p: string) =>
              deps.git.readFile(space, p).then(
                () => true,
                () => false,
              )
            // A note and, for a meeting, its transcript: both must be free.
            const path = await freePath(note.path, async (p) =>
              note.transcript
                ? (await exists(p)) || (await exists(p.replace(/\.md$/, '.transcript.md')))
                : exists(p),
            )
            const message = withVia(
              formatCommitMessage({
                app: to === 'meeting' ? 'meetings' : 'docs',
                verb: 'create from clip',
                title: clip.title,
              }),
              viaFor(principal),
            )
            if (note.transcript) {
              // The note and its transcript in one commit, side by side with the same suffix.
              const transcriptPath = path.replace(/\.md$/, '.transcript.md')
              const content = patchFrontmatter(note.content, {
                transcript: transcriptPath.slice(transcriptPath.lastIndexOf('/') + 1),
              })
              const result = await deps.git.commit(space, {
                changes: [
                  { path, content },
                  { path: transcriptPath, content: note.transcript.content },
                ],
                author: authorOf(principal),
                message,
              })
              await afterCommit(deps, space, path, result)
              return c.json({ space, path }, 201)
            }
            const result = await saveFile(deps, {
              space,
              path,
              content: note.content,
              author: authorOf(principal),
              message,
            })
            if (result.status === 'conflict') {
              throw new HearthError(
                'conflict',
                'Someone wrote that file at the same moment; try again',
              )
            }
            return c.json({ space, path }, 201)
          })
        },
      )
      .post('/:id/transcript/retry', valid('param', z.object({ id: ClipId })), async (c) =>
        c.json(await clips.retryTranscript(c.get('principal'), c.req.valid('param').id)),
      )
  )
}
