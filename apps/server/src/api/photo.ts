import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { type AccountStore, MAX_PHOTO_BYTES, photoType } from '../account/index.js'
import { HotsauceError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'

export { MAX_PHOTO_BYTES, photoType }

function tooLarge(): never {
  throw new HotsauceError('bad_request', 'Profile photos are limited to 500 KB', { status: 413 })
}

/** Where a member's photo is served; the tag changes with the photo, so it can be kept for good. */
export function photoUrl(account: AccountStore, email: string): string | null {
  const tag = account.photoTag(email)
  return tag ? `/api/members/${encodeURIComponent(email)}/photo?v=${tag}` : null
}

/**
 * Profile photos (docs/PLAN-rail-account-menu.md, requirements 12 to 16): a member sets or removes
 * their own; every signed-in member can see anyone's. Until they set one, the picture from their
 * sign-in stands in. Kept in the account store, so backups hold
 * them.
 */
export function photoRoutes(deps: AppDeps) {
  const { account, signInPhotos } = deps
  return (
    new Hono<AppEnv>()
      .put('/me/photo', bodyLimit({ maxSize: MAX_PHOTO_BYTES, onError: tooLarge }), async (c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer())
        if (bytes.byteLength > MAX_PHOTO_BYTES) tooLarge()
        const type = photoType(bytes)
        if (!type) {
          throw new HotsauceError(
            'bad_request',
            'A profile photo must be a JPEG, PNG or WebP image',
          )
        }
        const { email } = c.get('principal')
        account.setPhoto(email, type, bytes, new Date())
        return c.json({ photo: photoUrl(account, email) })
      })
      .delete('/me/photo', async (c) => {
        const { email } = c.get('principal')
        account.deletePhoto(email)
        // Back to the picture from their sign-in, when they have one (requirement 14).
        await signInPhotos?.restore(email)
        return c.json({ photo: photoUrl(account, email) })
      })
      // Who has a photo, so a face can be shown wherever a member is named (requirement 15).
      .get('/members/photos', (c) => {
        const photos: Record<string, string> = {}
        for (const { user, tag } of account.photoTags()) {
          photos[user] = `/api/members/${encodeURIComponent(user)}/photo?v=${tag}`
        }
        return c.json({ photos })
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
  )
}
