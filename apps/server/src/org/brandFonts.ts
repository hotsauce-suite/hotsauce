import { FONT_CHOICES } from './brand.js'

/**
 * The brand's fonts as TrueType files, for documents Hotsauce writes (a Doc downloaded as Word or
 * PDF, docs/PLAN-doc-download.md). Browsers get WOFF2 from Google Fonts, which Word can't embed
 * and PDF makers can't always read, so the server asks Google Fonts for the TTF itself (Google
 * serves TrueType to a client that doesn't claim WOFF2 support) and keeps each file in memory.
 * Only the families the brand wizard offers can be asked for, so this never fetches anything else.
 */

export type FontStyle = 'normal' | 'italic'
export type FontWeight = 400 | 700

const FAMILIES: ReadonlySet<string> = new Set(
  Object.values(FONT_CHOICES).flatMap((f) => [f.display, f.ui]),
)

export function isBrandFamily(family: string): boolean {
  return FAMILIES.has(family)
}

const TTF_URL = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/

export class BrandFonts {
  readonly #fetch: typeof fetch
  readonly #cache = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>()
  /** Styles Google Fonts doesn't have for a family. */
  readonly #missing = new Set<string>()

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.#fetch = options.fetch ?? fetch
  }

  /** The TTF bytes, or null when the family isn't a brand font or Google Fonts can't be reached. */
  get(
    family: string,
    weight: FontWeight,
    style: FontStyle,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!isBrandFamily(family)) return Promise.resolve(null)
    const key = `${family}|${weight}|${style}`
    if (this.#missing.has(key)) return Promise.resolve(null)
    let found = this.#cache.get(key)
    if (!found) {
      found = this.#load(family, weight, style, key)
      this.#cache.set(key, found)
      // A miss (no network) is tried again next time rather than remembered.
      found.then((bytes) => {
        if (!bytes) this.#cache.delete(key)
      })
    }
    return found
  }

  async #load(
    family: string,
    weight: FontWeight,
    style: FontStyle,
    key: string,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    const ital = style === 'italic' ? 1 : 0
    const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${ital},${weight}`
    try {
      const sheet = await this.#fetch(css, {
        headers: { 'User-Agent': 'Hotsauce' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!sheet.ok) {
        // Google Fonts says the family has no such style (Space Grotesk has no italic): that
        // answer won't change, so it isn't asked again.
        if (sheet.status >= 400 && sheet.status < 500) this.#missing.add(key)
        return null
      }
      const url = TTF_URL.exec(await sheet.text())?.[1]
      if (!url) return null
      const file = await this.#fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!file.ok) return null
      const bytes = new Uint8Array(await file.arrayBuffer())
      return bytes.byteLength > 0 ? bytes : null
    } catch {
      return null
    }
  }
}
