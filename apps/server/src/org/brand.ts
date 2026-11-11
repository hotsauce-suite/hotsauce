import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { writeAtomic } from './store.js'

/**
 * The brand kit (ARCHITECTURE §11.3): one per organization. Every app reads it: the web app turns
 * it into CSS variables (`--brand-*`), AI writing follows `voice`, and agents read it through the
 * MCP tool `get_brand`. Served at GET /api/org/brand, which needs no session so the sign-in page
 * can be branded too.
 */

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color like #c63d19')

/** Font pairs offered in the wizard. All on Google Fonts, all with a sensible fallback. */
export const FONT_CHOICES = {
  classic: { label: 'Fraunces + IBM Plex Sans', display: 'Fraunces', ui: 'IBM Plex Sans' },
  modern: { label: 'Space Grotesk + Inter', display: 'Space Grotesk', ui: 'Inter' },
  editorial: {
    label: 'Playfair Display + Source Sans 3',
    display: 'Playfair Display',
    ui: 'Source Sans 3',
  },
  friendly: {
    label: 'Bricolage Grotesque + DM Sans',
    display: 'Bricolage Grotesque',
    ui: 'DM Sans',
  },
  technical: {
    label: 'IBM Plex Serif + IBM Plex Sans',
    display: 'IBM Plex Serif',
    ui: 'IBM Plex Sans',
  },
  simple: { label: 'Inter only', display: 'Inter', ui: 'Inter' },
} as const
export type FontChoice = keyof typeof FONT_CHOICES

export const BrandSchema = z.object({
  primary: hex.default('#c63d19'),
  accent: hex.default('#ee9a46'),
  neutral: z.enum(['warm', 'cool', 'gray']).default('warm'),
  fonts: z.enum(Object.keys(FONT_CHOICES) as [FontChoice, ...FontChoice[]]).default('classic'),
  defaultTheme: z.enum(['system', 'light', 'dark']).default('system'),
  /** File names under <DATA_DIR>/org/assets, or null for none. */
  logo: z.string().nullable().default(null),
  mark: z.string().nullable().default(null),
  /** How the organization writes: guidance for AI-written notes and summaries. */
  voice: z.string().max(2000).default(''),
  updatedAt: z.string().optional(),
})
export type Brand = z.infer<typeof BrandSchema>

export const BrandPatchSchema = BrandSchema.partial().omit({
  updatedAt: true,
  logo: true,
  mark: true,
})

export class BrandStore {
  readonly #file: string
  constructor(orgDir: string) {
    this.#file = path.join(orgDir, 'brand.json')
  }

  get(): Brand {
    if (!existsSync(this.#file)) return BrandSchema.parse({})
    try {
      return BrandSchema.parse(JSON.parse(readFileSync(this.#file, 'utf8')))
    } catch (err) {
      console.error(`brand.json is not valid, using the default brand: ${(err as Error).message}`)
      return BrandSchema.parse({})
    }
  }

  save(patch: { [K in keyof Brand]?: Brand[K] | undefined }): Brand {
    const next = BrandSchema.parse({
      ...this.get(),
      ...defined(patch),
      updatedAt: new Date().toISOString(),
    })
    writeAtomic(this.#file, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /** The brand as served: fonts expanded, asset names turned into URLs. */
  publicView(productName: string, orgName: string) {
    const b = this.get()
    const v = b.updatedAt ? encodeURIComponent(b.updatedAt) : '0'
    return {
      productName,
      orgName,
      primary: b.primary,
      accent: b.accent,
      neutral: b.neutral,
      fonts: { choice: b.fonts, ...FONT_CHOICES[b.fonts] },
      defaultTheme: b.defaultTheme,
      logoUrl: b.logo ? `/api/org/assets/logo?v=${v}` : null,
      markUrl: b.mark
        ? `/api/org/assets/mark?v=${v}`
        : b.logo
          ? `/api/org/assets/logo?v=${v}`
          : null,
      voice: b.voice,
      updatedAt: b.updatedAt ?? null,
    }
  }
}

export type PublicBrand = ReturnType<BrandStore['publicView']>

/** Logo and mark uploads: small images only. SVG is served with a locked-down CSP. */
export const ASSET_TYPES: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
export const MAX_ASSET_BYTES = 1024 * 1024

/** Drops keys whose value is undefined, so a patch never resets a field to its default. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
