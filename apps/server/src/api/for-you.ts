import { isCommentableId } from '@hotsauce/format'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const Item = z.object({ item: z.string().refine(isCommentableId) })
const Mark = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['seen', 'done', 'undone']) }),
  z.object({
    action: z.literal('later'),
    when: z.enum(['tomorrow', 'monday']),
    zone: z.string().min(1).max(80),
  }),
])

/**
 * For you (ARCHITECTURE §27.5): what is waiting on the member asking, and their marks on it.
 * Each member sees and marks only their own list.
 */
export function forYouRoutes(deps: Pick<AppDeps, 'forYou'>) {
  const { forYou } = deps
  return new Hono<AppEnv>()
    .get('/for-you', async (c) => c.json(await forYou.list(c.get('principal'))))
    .post('/for-you/:item', valid('param', Item), valid('json', Mark), async (c) =>
      c.json(await forYou.mark(c.get('principal'), c.req.valid('param').item, c.req.valid('json'))),
    )
}
