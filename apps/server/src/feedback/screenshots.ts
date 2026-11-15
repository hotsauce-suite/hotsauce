import { randomBytes } from 'node:crypto'
import { HotsauceError } from '../errors.js'

/** docs/PLAN-feedback-screenshots.md S4: at most three pictures per item, 5 MB each. */
export const MAX_SCREENSHOTS = 3
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024

export interface ImageKind {
  ext: 'png' | 'jpg' | 'gif' | 'webp'
  type: string
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to))

/** The picture's real type from its first bytes; null for anything but PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a)
    return { ext: 'png', type: 'image/png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { ext: 'jpg', type: 'image/jpeg' }
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'))
    return { ext: 'gif', type: 'image/gif' }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return { ext: 'webp', type: 'image/webp' }
  return null
}

/** Checks every picture and names where each goes in the feedback repo. */
export function checkScreenshots(
  screenshots: Uint8Array[],
  now: Date,
): { bytes: Uint8Array; path: string }[] {
  if (screenshots.length > MAX_SCREENSHOTS) {
    throw new HotsauceError('bad_request', `Attach at most ${MAX_SCREENSHOTS} screenshots`)
  }
  const month = now.toISOString().slice(0, 7)
  return screenshots.map((bytes) => {
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new HotsauceError('bad_request', 'Each screenshot must be 5 MB or smaller')
    }
    const kind = sniffImage(bytes)
    if (!kind) {
      throw new HotsauceError('bad_request', 'Screenshots must be PNG, JPEG, WebP or GIF images')
    }
    return {
      bytes,
      path: `screenshots/${month}/${randomBytes(12).toString('base64url')}.${kind.ext}`,
    }
  })
}
