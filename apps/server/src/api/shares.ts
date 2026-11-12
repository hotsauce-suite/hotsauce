import { Hono } from 'hono'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

/** Where a read-only link is opened; `authenticate` lets these through with or without a session. */
export const SHARED_PREFIX = '/api/shared/'

const Space = z.string().min(1).max(100)

/** Read-only links (ARCHITECTURE §20). Spaces are checked in the service. */
export function shareRoutes(deps: Pick<AppDeps, 'shares' | 'org'>) {
  const { shares, org } = deps
  // Signed out, a link opens only when the organization allows "anyone with the link". Checked
  // before the token, so a guess from outside learns nothing about which tokens exist.
  const viewer = (principal: Principal | undefined) => {
    if (!principal && !org.settings().publicShareLinks) {
      throw new HearthError('unauthorized', 'Sign in to open this link')
    }
  }
  return (
    new Hono<AppEnv>()
      // Whether links open for signed-out people: any member may know (the Share menu says so);
      // only an admin, in a session, may change it. It applies at once, without a restart.
      .get('/sharing', (c) => c.json({ publicShareLinks: org.settings().publicShareLinks }))
      .put('/sharing', valid('json', z.object({ publicShareLinks: z.boolean() })), (c) => {
        const p = c.get('principal')
        if (!p.isAdmin || p.via) {
          throw new HearthError('forbidden', 'Only an admin can change who can open links')
        }
        const { publicShareLinks } = org.saveSettings(c.req.valid('json'))
        return c.json({ publicShareLinks })
      })
      .get('/shares', valid('query', z.object({ space: Space, path: PathParam })), async (c) => {
        const { space, path } = c.req.valid('query')
        return c.json(await shares.state(c.get('principal'), space, path))
      })
      .post(
        '/shares',
        valid('json', z.object({ space: Space, path: PathParam, on: z.boolean() })),
        async (c) => {
          const { space, path, on } = c.req.valid('json')
          const principal = c.get('principal')
          return c.json(await shares.set(principal, space, path, on, viaFor(principal)))
        },
      )
      .get('/shared/:token', async (c) => {
        viewer(c.get('principal') as Principal | undefined)
        const file = await shares.open(c.req.param('token'))
        c.header('Cache-Control', 'private, no-store')
        return c.json(file.item)
      })
      .get('/shared/:token/asset', async (c) => {
        viewer(c.get('principal') as Principal | undefined)
        const src = c.req.query('src') ?? ''
        const { bytes, contentType } = await shares.asset(c.req.param('token'), src)
        return c.body(new Uint8Array(bytes), 200, {
          'Content-Type': contentType,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        })
      })
  )
}
