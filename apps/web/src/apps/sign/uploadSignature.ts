// The browser side of an uploaded signature (docs/PLAN-sign-saved-signature.md R1, R2): decode the
// picture, clean it with `cleanSignature`, and give back a PNG data URL small enough to sign with.

import { MAX_DRAWN_SIGNATURE_CHARS } from '@hotsauce/format'
import { cleanSignature, fitWithin, type Pixels, type Prepared } from './cleanSignature'

/** Pictures are read at most this size; a phone photo is far bigger than a signature needs. */
const READ_MAX = 1600
/** The cleaned signature is kept at most this size, which stays sharp in any field. */
const KEEP_W = 1200
const KEEP_H = 400

/** The kinds of picture the Upload tab takes; HEIC opens where the browser can read it (Safari, the Mac app). */
export const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,image/heif,image/gif'
/** Bigger files than this are refused before reading: even a raw phone photo is smaller. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export type Uploaded = { ok: true; image: string } | { ok: false; message: string }

/** A picture's pixels, scaled down to fit `READ_MAX`; null when the browser can't read it. */
export async function readPicture(file: Blob): Promise<Pixels | null> {
  if (file.size > MAX_UPLOAD_BYTES) return null
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, READ_MAX, READ_MAX)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    const data = ctx.getImageData(0, 0, width, height)
    return { data: data.data, width, height }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Cleans a picture at the Ink slider's `strength` and makes the PNG to sign with. */
export function signatureFromPicture(
  pixels: Prepared,
  strength: number,
  label: 'signature' | 'initials',
): Uploaded {
  const r = cleanSignature(pixels, strength)
  if (!r.ok) {
    return {
      ok: false,
      message:
        r.reason === 'too-dark'
          ? 'That picture is too dark to find your ' +
            `${label} in. Try a photo of dark ink on white paper, in good light.`
          : `No ${label} found in that picture. Try a photo of dark ink on white paper, or move the Ink slider up.`,
    }
  }
  const full = document.createElement('canvas')
  full.width = r.image.width
  full.height = r.image.height
  full
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(r.image.data), r.image.width), 0, 0)
  let size = fitWithin(r.image.width, r.image.height, KEEP_W, KEEP_H)
  for (let tries = 0; tries < 6; tries++) {
    const out = document.createElement('canvas')
    out.width = size.width
    out.height = size.height
    const ctx = out.getContext('2d')
    if (!ctx) break
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, 0, 0, size.width, size.height)
    const image = out.toDataURL('image/png')
    if (image.length <= MAX_DRAWN_SIGNATURE_CHARS) return { ok: true, image }
    size = fitWithin(size.width, size.height, size.width * 0.75, size.height * 0.75)
  }
  return { ok: false, message: `That ${label} is too detailed to keep. Try a simpler photo.` }
}
