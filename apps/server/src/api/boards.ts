import { BoardScene } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_BOARD_LIST } from '../boards/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Params = z.object({ space: z.string().min(1), id: z.string().min(1) })
const Title = z.string().max(500)

const ListQuery = z.object({
  space: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_BOARD_LIST).optional(),
})

/** Hearth Whiteboard (ARCHITECTURE §15.3). Space access is checked by the service (403). */
export function boardRoutes(deps: Pick<AppDeps, 'boards'>) {
  const service = deps.boards
  return new Hono<AppEnv>()
    .basePath('/boards')
    .get('/', valid('query', ListQuery), async (c) => {
      const boards = await service.list(c.get('principal'), c.req.valid('query'))
      return c.json({ boards })
    })
    .post(
      '/',
      valid(
        'json',
        z.object({
          title: Title.optional(),
          space: z.string().min(1).optional(),
          scene: BoardScene.optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const board = await service.create(principal, c.req.valid('json'), viaFor(principal))
        return c.json(board, 201)
      },
    )
    .get('/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      return c.json(await service.get(c.get('principal'), space, id))
    })
    .put(
      '/:space/:id',
      valid('param', Params),
      valid(
        'json',
        z.object({
          scene: BoardScene.optional(),
          title: Title.optional(),
          baseBlobOid: z.string().min(1).max(100).optional(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        const { space, id } = c.req.valid('param')
        return c.json(
          await service.save(principal, space, id, c.req.valid('json'), viaFor(principal)),
        )
      },
    )
    .delete('/:space/:id', valid('param', Params), async (c) => {
      const principal = c.get('principal')
      const { space, id } = c.req.valid('param')
      await service.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}
