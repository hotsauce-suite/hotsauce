// A member's profile photo (docs/PLAN-rail-account-menu.md, requirements 12 to 16). The browser
// crops what they pick to a small square before sending it, so the server never handles a camera's
// 12 MB original; the server keeps only JPEG, PNG or WebP, judged by the bytes.

import { useEffect, useState } from 'react'
import { request, requestBlob } from '../api/client'

/** The side of the square that's kept, in pixels: sharp at the 36 px it shows at, on any screen. */
export const PHOTO_SIZE = 256
/** The biggest file a member may pick; the square made from it is far smaller. */
export const MAX_PICKED_BYTES = 20 * 1024 * 1024

export type Square = (file: Blob) => Promise<Blob>

/** The middle square of an image, scaled to PHOTO_SIZE, as a JPEG. */
export const squarePhoto: Square = async (file) => {
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const side = Math.min(image.width, image.height)
    const canvas = document.createElement('canvas')
    canvas.width = PHOTO_SIZE
    canvas.height = PHOTO_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas')
    ctx.imageSmoothingQuality = 'high'
    // A see-through picture gets white behind it, not JPEG's black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE)
    ctx.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      PHOTO_SIZE,
      PHOTO_SIZE,
    )
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No picture'))),
        'image/jpeg',
        0.9,
      ),
    )
  } finally {
    image.close()
  }
}

export const photoApi = {
  /** Sends the square; answers the photo's new address. */
  set: (square: Blob) =>
    request<{ photo: string }>('/api/me/photo', {
      method: 'PUT',
      body: square,
      contentType: square.type || 'image/jpeg',
    }),
  remove: () => request<{ photo: null }>('/api/me/photo', { method: 'DELETE' }),
}

/** Why a picked file can't be a photo, in words for the member; null when it can. */
export function refusal(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Choose a picture: a JPEG, PNG or WebP file.'
  if (file.size > MAX_PICKED_BYTES) return 'That picture is over 20 MB. Choose a smaller one.'
  return null
}

// An `<img src>` can't carry the sign-in token (lib/assets.ts), so photos are fetched through the
// API client and shown as object URLs: one per photo address, kept while the page lives. The
// address changes with the photo, so an entry never goes stale.
const loaded = new Map<string, Promise<string | null>>()

function load(photo: string): Promise<string | null> {
  let url = loaded.get(photo)
  if (!url) {
    url = requestBlob(photo).then(
      (blob) => URL.createObjectURL(blob),
      () => {
        // Offline, or the photo is gone: initials now, and another try next time.
        loaded.delete(photo)
        return null
      },
    )
    loaded.set(photo, url)
  }
  return url
}

/** Forgets every loaded photo (tests). */
export function forgetPhotos(): void {
  loaded.clear()
}

/** Something an `<img>` can show for a photo's address; null while loading or without a photo. */
export function usePhotoSrc(photo: string | null | undefined): string | null {
  const [src, setSrc] = useState<{ photo: string; url: string } | null>(null)
  useEffect(() => {
    if (!photo) return
    let live = true
    void load(photo).then((url) => {
      if (live && url) setSrc({ photo, url })
    })
    return () => {
      live = false
    }
  }, [photo])
  return photo && src?.photo === photo ? src.url : null
}
