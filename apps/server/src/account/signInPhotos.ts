import type { AccountStore } from './store.js'

/**
 * A profile photo is a small square the web app makes before sending (256 px, well under this);
 * the limit only bounds what is kept.
 */
export const MAX_PHOTO_BYTES = 512 * 1024

/**
 * What the bytes are, whatever anyone called them: only these three are kept, so nothing a
 * browser would run (an SVG, a page) is ever served back as a member's photo.
 */
export function photoType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/** Fetches a picture's bytes; null when there is nothing usable there. */
export type PhotoFetch = (url: string) => Promise<Uint8Array | null>

/** The address to ask for: the same picture as a 256 px square. Null unless it is https. */
export function sizedPhotoUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  parsed.searchParams.set('width', '256')
  parsed.searchParams.set('height', '256')
  parsed.searchParams.set('fit', 'crop')
  parsed.searchParams.set('quality', '85')
  return parsed.toString()
}

const fetchSmallImage: PhotoFetch = async (url) => {
  const sized = sizedPhotoUrl(url)
  if (!sized) return null
  const res = await fetch(sized, {
    headers: { Accept: 'image/webp,image/jpeg,image/png' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null
  if (Number(res.headers.get('content-length') ?? 0) > MAX_PHOTO_BYTES) return null
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * The photo a member has where they sign in (their Google picture), kept as their profile photo
 * until they upload one of their own (docs/PLAN-rail-account-menu.md, requirement 14). An upload
 * is never touched; removing it brings this one back.
 */
export class SignInPhotos {
  readonly #account: AccountStore
  readonly #fetch: PhotoFetch
  /** Email → the sign-in photo's address as last heard, null for none. */
  readonly #known = new Map<string, string | null>()
  readonly #busy = new Map<string, Promise<void>>()

  constructor(account: AccountStore, fetchPhoto: PhotoFetch = fetchSmallImage) {
    this.#account = account
    this.#fetch = fetchPhoto
  }

  /** Sign-in says this is the member's picture now (null: they have none). Never throws. */
  offer(email: string, url: string | null): Promise<void> {
    const user = email.toLowerCase()
    this.#known.set(user, url)
    const before = this.#busy.get(user) ?? Promise.resolve()
    const next = before.then(() => this.#apply(user, url)).catch(() => {})
    this.#busy.set(user, next)
    void next.then(() => {
      if (this.#busy.get(user) === next) this.#busy.delete(user)
    })
    return next
  }

  /** After a member removed their own photo: back to the sign-in one, when there is one. */
  restore(email: string): Promise<void> {
    const user = email.toLowerCase()
    return this.offer(user, this.#known.get(user) ?? null)
  }

  async #apply(user: string, url: string | null): Promise<void> {
    const mine = () => this.#account.photoOrigin(user)
    const now = mine()
    if (now?.source === 'upload') return
    if (!url) {
      if (now) this.#account.deletePhoto(user)
      return
    }
    if (now?.origin === url) return
    const bytes = await this.#fetch(url)
    if (!bytes || bytes.byteLength > MAX_PHOTO_BYTES) return
    const type = photoType(bytes)
    // The member may have uploaded their own while this was on its way.
    if (!type || mine()?.source === 'upload') return
    this.#account.setPhoto(user, type, bytes, new Date(), url)
  }
}
