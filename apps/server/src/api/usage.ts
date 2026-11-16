import { Hono } from 'hono'
import { HotsauceError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'

/**
 * Settings → Organization → Usage (docs/PLAN-app-usage.md): how much each app was used, week by
 * week. Admins only, never through an access token (U1); numbers only, never names (U9).
 */
export function usageRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().get('/admin/org/usage', async (c) => {
    const p = c.get('principal')
    if (!p?.isAdmin || p.via) throw new HotsauceError('forbidden', 'Only an admin can see usage')
    c.header('Cache-Control', 'no-store')
    return c.json(await deps.usage.report())
  })
}
