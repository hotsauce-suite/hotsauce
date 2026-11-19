import { Hono } from 'hono'
import { Breaks } from '../breaks/index.js'
import type { AppDeps, AppEnv } from './env.js'

/** `/api/breaks`: the member's screen-break settings (docs/PLAN-breaks.md B2). */
export function breakRoutes(deps: Pick<AppDeps, 'git' | 'spaces' | 'syncer'>) {
  const breaks = new Breaks({ git: deps.git, spaces: deps.spaces, syncer: deps.syncer })
  return new Hono<AppEnv>()
    .get('/breaks', async (c) => c.json(await breaks.get(c.get('principal'))))
    .put('/breaks', async (c) => {
      const body: unknown = await c.req.json().catch(() => null)
      const input = body && typeof body === 'object' && 'settings' in body ? body.settings : body
      return c.json(await breaks.save(c.get('principal'), input))
    })
}
