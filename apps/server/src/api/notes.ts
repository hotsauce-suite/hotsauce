import { KeepNote, NOTE_COLORS } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_IMPORT_NOTES, MAX_NOTE_LIST } from '../notes/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly, viaFor } from './tokens.js'
import { valid } from './validate.js'

const Label = z.string().trim().min(1).max(100)

/** The fields of a note a client can set; `null` clears a color or order. */
const NoteFields = {
  title: z.string().max(1000).optional(),
  body: z.string().max(200_000).optional(),
  color: z.enum(NOTE_COLORS).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  labels: z.array(Label).max(50).optional(),
  order: z.number().finite().nullable().optional(),
}

const Params = z.object({ space: z.string().min(1), id: z.string().min(1) })

const ListQuery = z.object({
  view: z.enum(['board', 'archive', 'trash']).optional(),
  label: z.string().max(100).optional(),
  space: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_NOTE_LIST).optional(),
})

/** Hearth Notes (ARCHITECTURE §14.3). Space access is checked by the service (403). */
export function noteRoutes(deps: Pick<AppDeps, 'notes'>) {
  const service = deps.notes
  return new Hono<AppEnv>()
    .basePath('/notes')
    .get('/', valid('query', ListQuery), async (c) => {
      const q = c.req.valid('query')
      const principal = c.get('principal')
      // The trash empties itself: opening it deletes what has been there over 30 days.
      if (q.view === 'trash') await service.emptyOldTrash(principal)
      const notes = await service.list(principal, q)
      return c.json({ notes })
    })
    .get('/labels', async (c) => c.json(await service.labels(c.get('principal'))))
    .post(
      '/',
      valid('json', z.object({ ...NoteFields, space: z.string().min(1).optional() })),
      async (c) => {
        const principal = c.get('principal')
        const note = await service.create(principal, c.req.valid('json'), viaFor(principal))
        return c.json(note, 201)
      },
    )
    .post(
      '/import/keep',
      valid(
        'json',
        z.object({
          notes: z
            .array(z.object({ ref: z.string().min(1).max(500), note: KeepNote }))
            .max(MAX_IMPORT_NOTES),
        }),
      ),
      async (c) => {
        const principal = sessionOnly(c.get('principal'))
        return c.json(await service.importKeep(principal, c.req.valid('json').notes))
      },
    )
    .get('/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      return c.json(await service.get(c.get('principal'), space, id))
    })
    .patch(
      '/:space/:id',
      valid('param', Params),
      valid('json', z.object({ ...NoteFields, baseBlobOid: z.string().min(1).optional() })),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        const { baseBlobOid, ...patch } = c.req.valid('json')
        return c.json(
          await service.update(principal, space, id, patch, viaFor(principal), { baseBlobOid }),
        )
      },
    )
    .post('/:space/:id/trash', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      return c.json(await service.trash(principal, space, id, viaFor(principal)))
    })
    .post('/:space/:id/restore', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      return c.json(await service.restore(principal, space, id, viaFor(principal)))
    })
    .post(
      '/:space/:id/move',
      valid('param', Params),
      valid('json', z.object({ toSpace: z.string().min(1) })),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        const { toSpace } = c.req.valid('json')
        return c.json(await service.move(principal, space, id, toSpace, viaFor(principal)))
      },
    )
    .delete('/:space/:id', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      await service.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}
