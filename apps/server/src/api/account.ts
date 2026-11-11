import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { PathParam, valid } from './validate.js'

const Item = z.object({ space: z.string().min(1), path: PathParam })

/** Who the member is, and their per-user lists. Recents and stars live in the index, keyed by email. */
export function accountRoutes(deps: AppDeps) {
  const { config, index, spaces } = deps
  const assertAccess = (principal: AppEnv['Variables']['principal'], space: string) => {
    if (!spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }
  return new Hono<AppEnv>()
    .get('/me', async (c) => {
      const principal = c.get('principal')
      return c.json({
        principal,
        spaces: await spaces.visibleSpaces(principal),
        settings: { idleCommitMs: config.IDLE_COMMIT_MS },
      })
    })
    .get('/recents', (c) => {
      const principal = c.get('principal')
      const recents = index.listRecents(principal.email)
      return c.json(recents.filter((r) => spaces.canAccess(principal, r.space)))
    })
    .post('/recents', valid('json', Item), (c) => {
      const principal = c.get('principal')
      const { space, path } = c.req.valid('json')
      assertAccess(principal, space)
      index.touchRecent(principal.email, space, path)
      return c.json({ ok: true as const })
    })
    .get('/stars', (c) => {
      const principal = c.get('principal')
      const stars = index.listStars(principal.email)
      return c.json(stars.filter((s) => spaces.canAccess(principal, s.space)))
    })
    .post('/stars', valid('json', Item.extend({ starred: z.boolean() })), (c) => {
      const principal = c.get('principal')
      const { space, path, starred } = c.req.valid('json')
      assertAccess(principal, space)
      index.setStarred(principal.email, space, path, starred)
      return c.json({ ok: true as const })
    })
}
