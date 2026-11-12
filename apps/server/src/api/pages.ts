import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Params = z.object({ space: z.string().min(1).max(100), id: z.string().min(1).max(40) })

/** Published pages (ARCHITECTURE §20.2): read here, written by MCP `publish_page`. */
export function pageRoutes(deps: Pick<AppDeps, 'pages'>) {
  const { pages } = deps
  return new Hono<AppEnv>()
    .basePath('/pages')
    .get('/', (c) => c.json({ pages: pages.list(c.get('principal')) }))
    .get(
      '/:space/:id',
      valid('param', Params),
      valid(
        'query',
        z.object({
          version: z
            .string()
            .regex(/^[0-9a-f]{40,64}$/)
            .optional(),
        }),
      ),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const { version } = c.req.valid('query')
        return c.json(await pages.get(c.get('principal'), space, id, version))
      },
    )
    .delete('/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      const principal = c.get('principal')
      await pages.remove(principal, space, id, viaFor(principal))
      return c.body(null, 204)
    })
}
