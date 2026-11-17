import { Hono } from 'hono'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import { type LinkRecord, linkEnded, SHARE_TOKEN } from '../shares/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { LinkChoice, linkOptions } from './link-choice.js'
import { viaFor } from './tokens.js'
import { PathParam, valid } from './validate.js'

/** Where a read-only link is opened; `authenticate` lets these through with or without a session. */
export const SHARED_PREFIX = '/api/shared/'

const Space = z.string().min(1).max(100)

/** Read-only links (ARCHITECTURE §20, docs/PLAN-outside-links.md). Spaces are checked in the service. */
export function shareRoutes(
  deps: Pick<AppDeps, 'shares' | 'org' | 'shareLinks' | 'clips' | 'files' | 'spaces'>,
) {
  const { shares, org, shareLinks, clips, files } = deps
  /**
   * Signed in, any live link opens. Signed out, only a link made for "anyone", while the
   * organization allows those; anything else is 401 whether or not the token exists, so a guess
   * from outside learns nothing. An ended link is 410.
   */
  const viewer = (principal: Principal | undefined, token: string): LinkRecord | null => {
    const row = SHARE_TOKEN.test(token) ? shareLinks.get(token) : null
    if (!principal && (!org.settings().publicShareLinks || !row?.anyone)) {
      throw new HotsauceError('unauthorized', 'Sign in to open this link')
    }
    if (row && shareLinks.ended(row)) throw linkEnded()
    return row
  }
  const admin = (p: Principal) => {
    if (!p.isAdmin || p.via)
      throw new HotsauceError('forbidden', 'Only an admin can see every link')
  }
  return (
    new Hono<AppEnv>()
      // Whether links open for signed-out people: any member may know (the Share menu says so);
      // only an admin, in a session, may change it. It applies at once, without a restart.
      .get('/sharing', (c) => c.json({ publicShareLinks: org.settings().publicShareLinks }))
      .put('/sharing', valid('json', z.object({ publicShareLinks: z.boolean() })), (c) => {
        const p = c.get('principal')
        if (!p.isAdmin || p.via) {
          throw new HotsauceError('forbidden', 'Only an admin can change who can open links')
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
        valid('json', z.object({ space: Space, path: PathParam, on: z.boolean(), ...LinkChoice })),
        async (c) => {
          const body = c.req.valid('json')
          const principal = c.get('principal')
          return c.json(
            await shares.set(
              principal,
              body.space,
              body.path,
              body.on,
              viaFor(principal),
              linkOptions(body),
            ),
          )
        },
      )
      // Settings → Organization: every link recorded, for an admin to see and turn off.
      .get('/share-links', (c) => {
        admin(c.get('principal'))
        return c.json({
          links: shareLinks.list().map((l) => ({
            token: l.token,
            kind: l.kind,
            title: l.title,
            anyone: l.anyone,
            expiresAt: l.expiresAt,
            ended: shareLinks.ended(l),
            createdBy: l.createdBy,
            createdAt: l.createdAt,
            url: `/s/${l.token}`,
          })),
        })
      })
      .delete('/share-links/:token', (c) => {
        admin(c.get('principal'))
        const ended = shareLinks.end(c.req.param('token'))
        if (!ended) throw new HotsauceError('not_found', 'No such link')
        return c.body(null, 204)
      })
      .get('/shared/:token', async (c) => {
        const token = c.req.param('token')
        const principal = c.get('principal') as Principal | undefined
        const row = viewer(principal, token)
        c.header('Cache-Control', 'private, no-store')
        if (row?.kind === 'clip' && 'clip' in row.ref) {
          return c.json(await clips.sharedView(row.ref.clip))
        }
        if (row?.kind === 'file' || (!row && principal)) {
          // A Files item: recorded links, and (signed in) the older ones without a record.
          const v = await files.shared(token).catch((err: unknown) => {
            if (row) throw err
            return null
          })
          if (v) {
            return c.json({
              kind: 'file' as const,
              title: v.name,
              // An outsider sees the file itself: never who in the organization uploaded it.
              file: {
                name: v.name,
                size: v.size,
                mime: v.mime,
                preview: v.preview,
                ...(await files.urls(v)),
              },
              updated: v.updatedAt,
              updatedBy: null,
            })
          }
        }
        const file = await shares.open(token)
        return c.json(file.item)
      })
      .get('/shared/:token/asset', async (c) => {
        viewer(c.get('principal') as Principal | undefined, c.req.param('token'))
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
