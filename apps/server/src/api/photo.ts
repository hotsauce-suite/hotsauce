import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AccountStore } from '../account/index.js'
import { HotsauceError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'

/**
 * A profile photo is a small square the web app makes before sending (256 px, well under this);
 * the limit only bounds the request.
 */
export const MAX_PHOTO_BYTES = 512 * 1024

function tooLarge(): never {
  throw new HotsauceError('bad_request', 'Profile photos are limited to 500 KB', { status: 413 })
}

/**
 * What the bytes are, whatever the request called them: only these three are kept, so nothing a
 * browser would run (an SVG, a page) is ever served back as a member's photo.
 */
export function photoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/** Where a member's photo is served; the tag changes with the photo, so it can be kept for good. */
export function photoUrl(account: AccountStore, email: string): string | null {
  const tag = account.photoTag(email)
  return tag ? `/api/members/${encodeURIComponent(email)}/photo?v=${tag}` : null
}

/**
 * Profile photos (docs/PLAN-rail-account-menu.md, requirements 12 to 16): a member sets or removes
 * their own; every signed-in member can see anyone's. Kept in the account store, so backups hold
 * them.
 */
export function photoRoutes(deps: AppDeps) {
  const { account } = deps
  return new Hono<AppEnv>()
    .put('/me/photo', bodyLimit({ maxSize: MAX_PHOTO_BYTES, onError: tooLarge }), async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.byteLength > MAX_PHOTO_BYTES) tooLarge()
      const type = photoType(bytes)
      if (!type) {
        throw new HotsauceError('bad_request', 'A profile photo must be a JPEG, PNG or WebP image')
      }
      const { email } = c.get('principal')
      account.setPhoto(email, type, bytes, new Date())
      return c.json({ photo: photoUrl(account, email) })
    })
    .delete('/me/photo', (c) => {
      account.deletePhoto(c.get('principal').email)
      return c.json({ photo: null })
    })
    .get('/members/:email/photo', (c) => {
      const photo = account.getPhoto(c.req.param('email').toLowerCase())
      if (!photo) throw new HotsauceError('not_found', 'No photo')
      // With its tag in the address the photo never changes; without, ask again each time.
      const pinned = c.req.query('v') === photo.tag
      return c.body(new Uint8Array(photo.bytes), 200, {
        'Content-Type': photo.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': pinned ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        ETag: `"${photo.tag}"`,
      })
    })
}
