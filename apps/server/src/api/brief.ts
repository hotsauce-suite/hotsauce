import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_NOTES_CHARS } from '../brief/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Zone = z.string().min(1).max(100).optional()

/** Agent briefs (ARCHITECTURE §13.3): the member's own brief, rewriting it, and correcting it. */
export function briefRoutes(deps: Pick<AppDeps, 'briefs'>) {
  const { briefs } = deps
  return (
    new Hono<AppEnv>()
      .basePath('/brief')
      /** The brief and the member's corrections; `tz` enrols them for the nightly brief. */
      .get('/', valid('query', z.object({ tz: Zone })), async (c) => {
        const principal = c.get('principal')
        await briefs.touch(principal, c.req.valid('query').tz)
        return c.json(await briefs.read(principal))
      })
      /** Writes the brief now, even when nothing changed since the last one. */
      .post('/refresh', valid('json', z.object({ tz: Zone }).default({})), async (c) => {
        const principal = c.get('principal')
        await briefs.touch(principal, c.req.valid('json').tz)
        const via = viaFor(principal)
        const { status, state } = await briefs.refresh(principal, {
          force: true,
          ...(via ? { via } : {}),
        })
        return c.json({ status, ...state })
      })
      .put(
        '/notes',
        valid('json', z.object({ text: z.string().max(MAX_NOTES_CHARS) })),
        async (c) => {
          const principal = c.get('principal')
          await briefs.saveNotes(principal, c.req.valid('json').text, viaFor(principal))
          return c.body(null, 204)
        },
      )
  )
}
