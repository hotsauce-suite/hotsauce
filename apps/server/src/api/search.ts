import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

export function searchRoutes(deps: AppDeps) {
  const { index, spaces } = deps
  return new Hono<AppEnv>().get(
    '/search',
    valid(
      'query',
      z.object({
        q: z.string(),
        /** Comma-separated space names; defaults to every space the member can see. */
        spaces: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal')
      const query = c.req.valid('query')
      const requested = query.spaces
        ? query.spaces.split(',').map((s) => s.trim())
        : (await spaces.visibleSpaces(principal)).map((s) => s.name)
      // A space the member can't open is dropped silently, never searched.
      const allowed = requested.filter((s) => s !== '' && spaces.canAccess(principal, s))
      // Snippets mark matches with SNIPPET_OPEN / SNIPPET_CLOSE; the client renders them.
      const hits = index.search(query.q, {
        spaces: allowed,
        ...(query.limit ? { limit: query.limit } : {}),
      })
      return c.json(hits)
    },
  )
}
