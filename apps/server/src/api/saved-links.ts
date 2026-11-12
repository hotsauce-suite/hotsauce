import { findLinkUrl, LINK_SOURCES, MAX_LINK_URL } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { MAX_LINK_LIST } from '../links/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Tag = z.string().trim().min(1).max(100)
const Params = z.object({ space: z.string().min(1), id: z.string().min(1) })

const ListQuery = z.object({
  view: z.enum(['unread', 'archive', 'all']).optional(),
  tag: z.string().max(100).optional(),
  space: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LINK_LIST).optional(),
})

const SaveBody = z.object({
  url: z
    .string()
    .max(MAX_LINK_URL * 2)
    .optional(),
  /** A shared text with the link inside it (Android's share sheet puts it here). */
  text: z.string().max(10_000).optional(),
  title: z.string().max(1000).optional(),
  tags: z.array(Tag).max(20).optional(),
  space: z.string().min(1).optional(),
  source: z.enum(LINK_SOURCES).optional(),
})

/** Saved links (ARCHITECTURE §23.4). Space access is checked by the service (403). */
export function linkRoutes(deps: Pick<AppDeps, 'links'>) {
  const service = deps.links
  return new Hono<AppEnv>()
    .basePath('/links')
    .get('/', valid('query', ListQuery), async (c) => {
      return c.json({ links: await service.list(c.get('principal'), c.req.valid('query')) })
    })
    .get('/tags', async (c) => c.json(await service.tags(c.get('principal'))))
    .post('/', valid('json', SaveBody), async (c) => {
      const principal = c.get('principal')
      const body = c.req.valid('json')
      const url =
        (body.url?.trim() ? (findLinkUrl(body.url) ?? body.url.trim()) : null) ??
        findLinkUrl(body.text ?? '') ??
        findLinkUrl(body.title ?? '')
      if (!url) throw new HearthError('bad_request', 'There’s no web link in what was shared')
      const saved = await service.save(
        principal,
        { url, title: body.title, tags: body.tags, space: body.space, source: body.source },
        viaFor(principal),
      )
      return c.json(saved, saved.existing ? 200 : 201)
    })
    .get('/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      return c.json(await service.get(c.get('principal'), space, id))
    })
    .patch(
      '/:space/:id',
      valid('param', Params),
      valid(
        'json',
        z.object({
          title: z.string().max(1000).optional(),
          tags: z.array(Tag).max(20).optional(),
          archived: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        return c.json(
          await service.update(principal, space, id, c.req.valid('json'), viaFor(principal)),
        )
      },
    )
    .post('/:space/:id/refetch', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      return c.json(await service.refetch(principal, space, id, viaFor(principal)))
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
