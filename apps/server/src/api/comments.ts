import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

const Item = z.object({ space: z.string().min(1).max(120), path: PathParam })
const Ref = z.object({ item: z.string().min(1).max(64), id: z.string().min(1).max(40) })
// Longer than a comment may be, so the service can say how long one may be.
const Text = z.string().max(40_000)

/**
 * Comments (ARCHITECTURE §27.3): the conversation under a team doc, meeting note or task. Every
 * member reads and writes; who may edit or delete a comment is the service's to say.
 */
export function commentRoutes(deps: Pick<AppDeps, 'comments'>) {
  const { comments } = deps
  return new Hono<AppEnv>()
    .get('/comments', valid('query', Item), async (c) =>
      c.json(await comments.list(c.get('principal'), c.req.valid('query'))),
    )
    .get('/comments/members', async (c) =>
      c.json({
        members: (await comments.members(c.get('principal'))).map(({ email, name, handle }) => ({
          email,
          name,
          handle,
        })),
      }),
    )
    .post(
      '/comments',
      valid('json', Item.extend({ text: Text, quote: z.string().max(20_000).optional() })),
      async (c) => {
        const p = c.get('principal')
        return c.json(await comments.add(p, c.req.valid('json'), viaFor(p)), 201)
      },
    )
    .patch(
      '/comments/:item/:id',
      valid('param', Ref),
      valid('json', z.object({ text: Text })),
      async (c) => {
        const p = c.get('principal')
        const { item, id } = c.req.valid('param')
        return c.json(await comments.edit(p, item, id, c.req.valid('json'), viaFor(p)))
      },
    )
    .delete('/comments/:item/:id', valid('param', Ref), async (c) => {
      const p = c.get('principal')
      const { item, id } = c.req.valid('param')
      await comments.remove(p, item, id, viaFor(p))
      return c.body(null, 204)
    })
}
