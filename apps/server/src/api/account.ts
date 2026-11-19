import { Hono } from 'hono'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { photoUrl } from './photo.js'
import { PathParam, valid } from './validate.js'

const Item = z.object({ space: z.string().min(1), path: PathParam })

/**
 * A member pins as many apps as they like (the rail scrolls). This only bounds the request, well
 * above every app and link an instance has.
 */
export const MAX_PINS = 100
const AppIds = (max: number) =>
  z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'An app is pinned twice')
const Pins = z.object({ pins: AppIds(MAX_PINS) })

/** The phone's tab bar holds this many apps beside Apps (docs/PLAN-phone-tab-bar.md R5). */
export const MAX_PHONE_PINS = 5
const PhonePins = z.object({ pins: AppIds(MAX_PHONE_PINS) })

/** How many recents a member is shown. */
const RECENTS_LIMIT = 20

/**
 * Apps added once to the rail of members who arranged their pins before the app existed. New
 * members have them in the web app's default pins.
 */
const PIN_OFFERS = [{ app: 'for-you', after: 'today' }] as const

/**
 * Who the member is, and their per-user lists. Recents, stars and rail pins live in the account
 * store (backed up, keyed by email); titles come from the index, null when a file isn't indexed.
 * Pins (the rail's, and the phone tab bar's) are `null` until the member first changes them (the
 * app shows defaults).
 */
export function accountRoutes(deps: AppDeps) {
  const { config, index, account, spaces } = deps
  const assertAccess = (principal: AppEnv['Variables']['principal'], space: string) => {
    if (!spaces.canAccess(principal, space)) {
      throw new HotsauceError('forbidden', `You don't have access to the space "${space}"`)
    }
  }
  return new Hono<AppEnv>()
    .get('/me', async (c) => {
      const principal = c.get('principal')
      return c.json({
        principal,
        // Their profile photo's address, or null (docs/PLAN-rail-account-menu.md).
        photo: photoUrl(account, principal.email),
        spaces: await spaces.visibleSpaces(principal),
        settings: { idleCommitMs: config.IDLE_COMMIT_MS },
      })
    })
    .get('/recents', (c) => {
      const principal = c.get('principal')
      const recents = account
        .listRecents(principal.email, RECENTS_LIMIT)
        .filter((r) => spaces.canAccess(principal, r.space))
      return c.json(recents.map((r) => ({ ...r, title: index.titleOf(r.space, r.path) })))
    })
    .post('/recents', valid('json', Item), (c) => {
      const principal = c.get('principal')
      const { space, path } = c.req.valid('json')
      assertAccess(principal, space)
      account.touchRecent(principal.email, space, path)
      return c.json({ ok: true as const })
    })
    .get('/stars', (c) => {
      const principal = c.get('principal')
      const stars = account
        .listStars(principal.email)
        .filter((s) => spaces.canAccess(principal, s.space))
      return c.json(stars.map((s) => ({ ...s, title: index.titleOf(s.space, s.path) })))
    })
    .post('/stars', valid('json', Item.extend({ starred: z.boolean() })), (c) => {
      const principal = c.get('principal')
      const { space, path, starred } = c.req.valid('json')
      assertAccess(principal, space)
      account.setStarred(principal.email, space, path, starred)
      return c.json({ ok: true as const })
    })
    .get('/pins', (c) =>
      c.json({ pins: account.pinsWithOffers(c.get('principal').email, PIN_OFFERS) }),
    )
    .put('/pins', valid('json', Pins), (c) => {
      const { pins } = c.req.valid('json')
      account.setPins(c.get('principal').email, pins)
      return c.json({ pins })
    })
    // The first-run tour (docs/PLAN-tour-and-101.md S1, S2): seen once per member, on any device.
    .get('/tour', (c) => c.json({ seen: account.hasSeenTour(c.get('principal').email) }))
    .post('/tour/seen', (c) => {
      account.markTourSeen(c.get('principal').email, new Date())
      return c.json({ seen: true as const })
    })
    .get('/phone-pins', (c) => c.json({ pins: account.getPhonePins(c.get('principal').email) }))
    .put('/phone-pins', valid('json', PhonePins), (c) => {
      const { pins } = c.req.valid('json')
      account.setPhonePins(c.get('principal').email, pins)
      return c.json({ pins })
    })
}
