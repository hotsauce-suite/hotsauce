import { z } from 'zod'

/**
 * A member's own theme (docs/PLAN-ai-themes.md): one fixed look, colours and fonts only. The AI
 * writes the palette; `fixContrast` makes it readable; `themeTokens` turns it into the app's design
 * tokens (apps/web/src/styles/tokens.css), deriving the washes, borders and rings from it.
 */

const Hex = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'a colour like #1a2b3c')
  .transform((v) => (v.startsWith('#') ? v : `#${v}`).toLowerCase())

/** A Google Fonts family name: letters, digits and single spaces. */
const FontName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/, 'a Google Fonts family name')
  .max(40)

export const THEME_COLOR_KEYS = [
  'paper',
  'paperRaised',
  'paperSunk',
  'ash',
  'ink',
  'inkSoft',
  'inkFaint',
  'accent',
  'accentStrong',
  'glow',
  'moss',
  'codeBg',
  'codeKeyword',
  'codeString',
  'codeNumber',
  'codeComment',
  'codeFunction',
  'codeType',
  'codeProperty',
] as const
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number]

export const ThemeColors = z.object(
  Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, Hex])) as Record<ThemeColorKey, typeof Hex>,
)
export type ThemeColors = z.infer<typeof ThemeColors>

export const MAX_THEME_NAME = 40

export const Theme = z.object({
  name: z.string().trim().min(1).max(MAX_THEME_NAME),
  scheme: z.enum(['light', 'dark']),
  colors: ThemeColors,
  fonts: z.object({ display: FontName, ui: FontName }),
})
export type Theme = z.infer<typeof Theme>

/** What a member saved: the theme, plus who asked for what. */
export interface SavedTheme {
  id: string
  name: string
  prompt: string
  theme: Theme
  createdAt: string
}

/** At most this many saved themes a member. */
export const MAX_THEMES = 12
export const MAX_THEME_PROMPT = 500

// ------------------------------------------------------------------------------- colour maths

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

type Lch = { l: number; c: number; h: number }

function toOklch(hex: string): Lch {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) }
}

function oklchToRgb({ l: L, c, h }: Lch): Rgb {
  const A = c * Math.cos(h)
  const B = c * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma) as Rgb
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)

/** The colour at lightness `l`, keeping hue and as much chroma as fits in sRGB. */
function withLightness(lch: Lch, l: number): string {
  let lo = 0
  let hi = lch.c
  if (inGamut(oklchToRgb({ ...lch, l }))) return rgbToHex(oklchToRgb({ ...lch, l }))
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklchToRgb({ ...lch, l, c: mid }))) lo = mid
    else hi = mid
  }
  return rgbToHex(oklchToRgb({ ...lch, l, c: lo }))
}

/** `a` mixed with `b`, `t` of the way to b, in OKLab. */
export function mix(a: string, b: string, t: number): string {
  const p = toOklch(a)
  const q = toOklch(b)
  const pa = [p.l, p.c * Math.cos(p.h), p.c * Math.sin(p.h)]
  const qa = [q.l, q.c * Math.cos(q.h), q.c * Math.sin(q.h)]
  const [L, A, B] = pa.map((v, i) => v + ((qa[i] ?? 0) - v) * t) as Rgb
  const rgb = oklchToRgb({ l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) })
  return rgbToHex(rgb)
}

/**
 * `fg` with its lightness moved away from `bgs` (darker on light backgrounds, lighter on dark)
 * until it reaches `ratio` against every one of them. Unchanged when it already does.
 */
export function readableOn(fg: string, bgs: readonly string[], ratio: number): string {
  const ok = (c: string) => bgs.every((bg) => contrast(c, bg) >= ratio)
  if (ok(fg)) return fg
  const darker = bgs.reduce((sum, bg) => sum + luminance(bg), 0) / bgs.length > 0.18
  const lch = toOklch(fg)
  for (let step = 1; step <= 100; step++) {
    const l = darker ? lch.l - step * 0.01 : lch.l + step * 0.01
    const next = withLightness(lch, Math.min(1, Math.max(0, l)))
    if (ok(next)) return next
    if (l <= 0 || l >= 1) break
  }
  return darker ? '#000000' : '#ffffff'
}

/** A background pushed to the light or dark end its scheme needs (luminance ≥ 0.4 or ≤ 0.05). */
function backgroundFor(bg: string, scheme: Theme['scheme']): string {
  const lch = toOklch(bg)
  for (let step = 0; step <= 100; step++) {
    const l = scheme === 'light' ? lch.l + step * 0.01 : lch.l - step * 0.01
    const next = step === 0 ? bg : withLightness(lch, Math.min(1, Math.max(0, l)))
    const lum = luminance(next)
    if (scheme === 'light' ? lum >= 0.4 : lum <= 0.05) return next
  }
  return scheme === 'light' ? '#ffffff' : '#000000'
}

/** Each foreground, the backgrounds it is read on, and the ratio it needs there. */
export const CONTRAST_PAIRS: ReadonlyArray<{
  fg: ThemeColorKey
  on: readonly ThemeColorKey[]
  ratio: number
}> = [
  { fg: 'ink', on: ['paper', 'paperRaised', 'paperSunk'], ratio: 7 },
  { fg: 'inkSoft', on: ['paper', 'paperRaised', 'paperSunk'], ratio: 4.5 },
  { fg: 'inkFaint', on: ['paper', 'paperRaised'], ratio: 3 },
  // Buttons put paper-raised text on the accent; links and labels use accent-strong.
  { fg: 'accent', on: ['paper', 'paperRaised'], ratio: 4.5 },
  { fg: 'accentStrong', on: ['paper', 'paperRaised', 'paperSunk'], ratio: 4.5 },
  { fg: 'moss', on: ['paper', 'paperRaised'], ratio: 3 },
  { fg: 'codeKeyword', on: ['codeBg'], ratio: 4.5 },
  { fg: 'codeString', on: ['codeBg'], ratio: 4.5 },
  { fg: 'codeNumber', on: ['codeBg'], ratio: 4.5 },
  { fg: 'codeComment', on: ['codeBg'], ratio: 3 },
  { fg: 'codeFunction', on: ['codeBg'], ratio: 4.5 },
  { fg: 'codeType', on: ['codeBg'], ratio: 4.5 },
  { fg: 'codeProperty', on: ['codeBg'], ratio: 4.5 },
]

const BACKGROUNDS = ['paper', 'paperRaised', 'paperSunk', 'codeBg'] as const

/** The theme with every colour readable: backgrounds first, then each pair in CONTRAST_PAIRS. */
export function fixContrast(theme: Theme): Theme {
  const colors = { ...theme.colors }
  for (const key of BACKGROUNDS) colors[key] = backgroundFor(colors[key], theme.scheme)
  for (const pair of CONTRAST_PAIRS) {
    colors[pair.fg] = readableOn(
      colors[pair.fg],
      pair.on.map((k) => colors[k]),
      pair.ratio,
    )
  }
  return { ...theme, colors }
}

// ------------------------------------------------------------------------------ parsing, CSS

/**
 * The theme in a model's answer: the JSON inside `<theme>…</theme>` (or the first `{…}`), checked,
 * with readable colours. Null when there is none or it doesn't fit.
 */
export function parseTheme(text: string): Theme | null {
  const tagged = /<theme>([\s\S]*?)<\/theme>/.exec(text)?.[1]
  const raw = tagged ?? /\{[\s\S]*\}/.exec(text)?.[0]
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(raw.trim())
  } catch {
    return null
  }
  const parsed = Theme.safeParse(json)
  return parsed.success ? fixContrast(parsed.data) : null
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * 255))
  return `rgb(${r} ${g} ${b} / ${a})`
}

const DISPLAY_FALLBACK = 'ui-serif, Georgia, serif'
const UI_FALLBACK = 'ui-sans-serif, system-ui, "Helvetica Neue", sans-serif'

/** The app's design tokens (CSS custom property → value) for a theme. */
export function themeTokens(theme: Theme): Record<string, string> {
  const c = theme.colors
  const dark = theme.scheme === 'dark'
  const inkAi = readableOn(mix(c.inkSoft, c.inkFaint, 0.5), [c.paper, c.paperRaised], 4.5)
  const chevron = encodeURIComponent(c.inkSoft)
  const shadow = dark ? '0 0 0' : '20 16 12'
  return {
    'color-scheme': theme.scheme,
    '--paper': c.paper,
    '--paper-raised': c.paperRaised,
    '--paper-sunk': c.paperSunk,
    '--ash': c.ash,
    '--ash-strong': mix(c.ash, c.ink, 0.2),
    '--ink': c.ink,
    '--ink-soft': c.inkSoft,
    '--ink-faint': c.inkFaint,
    '--ink-ai': inkAi,
    '--select-chevron': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='${chevron}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E")`,
    '--ember': c.accent,
    '--ember-strong': c.accentStrong,
    '--ember-wash': alpha(c.accent, dark ? 0.13 : 0.1),
    '--glow': c.glow,
    '--moss': c.moss,
    '--moss-wash': alpha(c.moss, 0.13),
    '--rust-wash': alpha(c.accent, dark ? 0.13 : 0.11),
    '--brand-primary': c.accent,
    '--brand-accent': c.glow,
    '--code-bg': c.codeBg,
    '--code-keyword': c.codeKeyword,
    '--code-string': c.codeString,
    '--code-number': c.codeNumber,
    '--code-comment': c.codeComment,
    '--code-function': c.codeFunction,
    '--code-type': c.codeType,
    '--code-property': c.codeProperty,
    '--shadow-float': dark
      ? '0 18px 44px -16px rgb(0 0 0 / 0.6), 0 3px 10px -3px rgb(0 0 0 / 0.4)'
      : `0 18px 40px -18px rgb(${shadow} / 0.35), 0 3px 8px -3px rgb(${shadow} / 0.16)`,
    '--focus-ring': `0 0 0 2px var(--paper), 0 0 0 4px ${alpha(c.accent, 0.6)}`,
    '--type-display': `"${theme.fonts.display}", ${DISPLAY_FALLBACK}`,
    '--type-ui': `"${theme.fonts.ui}", ${UI_FALLBACK}`,
  }
}

/**
 * The stylesheet that applies a theme while `<html data-theme="custom">`. `html:root` outranks
 * tokens.css and the organization's brand (`:root…` selectors), so the theme wins while it's on.
 */
export function themeCss(theme: Theme): string {
  const body = Object.entries(themeTokens(theme))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')
  return `html:root[data-theme="custom"] { ${body} }`
}

/** Google Fonts stylesheet for a theme's fonts. */
export function themeFontsHref(theme: Theme): string {
  const fam = (f: string) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700`
  const names = [...new Set([theme.fonts.display, theme.fonts.ui])]
  return `https://fonts.googleapis.com/css2?${names.map(fam).join('&')}&display=swap`
}

/** Hotsauce's own light look as a theme: the starting point when a member hasn't previewed one. */
export const DEFAULT_LIGHT_THEME: Theme = {
  name: 'Light',
  scheme: 'light',
  colors: {
    paper: '#f2eadf',
    paperRaised: '#faf5ee',
    paperSunk: '#e8ddcf',
    ash: '#d6c7b4',
    ink: '#2a221d',
    inkSoft: '#5b4e44',
    inkFaint: '#8c7c6e',
    accent: '#c63d19',
    accentStrong: '#a5300f',
    glow: '#ee9a46',
    moss: '#4a6a3a',
    codeBg: '#ebe1d3',
    codeKeyword: '#a3361a',
    codeString: '#56702b',
    codeNumber: '#96570f',
    codeComment: '#978676',
    codeFunction: '#84461f',
    codeType: '#3c6670',
    codeProperty: '#6a4c2a',
  },
  fonts: { display: 'Fraunces', ui: 'IBM Plex Sans' },
}

/**
 * Ready-made themes for when there is no model: the fake one in development and tests, and the
 * live demo (docs/PLAN-ai-themes.md R11). Each lists words that pick it.
 */
export const SAMPLE_THEMES: ReadonlyArray<{ words: readonly string[]; theme: Theme }> = [
  {
    words: ['midnight', 'night', 'blue', 'navy', 'ocean', 'dark'],
    theme: {
      name: 'Midnight Harbor',
      scheme: 'dark',
      colors: {
        paper: '#141a2a',
        paperRaised: '#1c2337',
        paperSunk: '#0f1421',
        ash: '#2c3550',
        ink: '#e4e9f5',
        inkSoft: '#aab4cc',
        inkFaint: '#7b86a0',
        accent: '#6ea8ff',
        accentStrong: '#9cc3ff',
        glow: '#ffc773',
        moss: '#8fd19e',
        codeBg: '#192036',
        codeKeyword: '#ff9e8a',
        codeString: '#a5d98b',
        codeNumber: '#f5c06b',
        codeComment: '#7983a0',
        codeFunction: '#9cc3ff',
        codeType: '#7fd6d0',
        codeProperty: '#d9b8ff',
      },
      fonts: { display: 'Space Grotesk', ui: 'Inter' },
    },
  },
  {
    words: ['terminal', 'hacker', 'retro', 'green', 'matrix', 'code', 'mono'],
    theme: {
      name: 'Green Phosphor',
      scheme: 'dark',
      colors: {
        paper: '#0d140f',
        paperRaised: '#142018',
        paperSunk: '#09100b',
        ash: '#22382a',
        ink: '#c8f5d2',
        inkSoft: '#8fd3a0',
        inkFaint: '#5f9c70',
        accent: '#4ef08a',
        accentStrong: '#7dffab',
        glow: '#ffd166',
        moss: '#9be564',
        codeBg: '#111b14',
        codeKeyword: '#7dffab',
        codeString: '#e6f59a',
        codeNumber: '#ffd166',
        codeComment: '#5f9c70',
        codeFunction: '#9be8ff',
        codeType: '#b8f5c9',
        codeProperty: '#d2ffb0',
      },
      fonts: { display: 'IBM Plex Mono', ui: 'IBM Plex Mono' },
    },
  },
  {
    words: ['pastel', 'soft', 'pink', 'notebook', 'light', 'spring', 'calm'],
    theme: {
      name: 'Pastel Notebook',
      scheme: 'light',
      colors: {
        paper: '#fbf3f4',
        paperRaised: '#fffafa',
        paperSunk: '#f3e6e9',
        ash: '#e6d1d6',
        ink: '#3a2b33',
        inkSoft: '#6a5560',
        inkFaint: '#9a8590',
        accent: '#b04a78',
        accentStrong: '#963a64',
        glow: '#f2a7c3',
        moss: '#4d7a5c',
        codeBg: '#f6eaee',
        codeKeyword: '#9c3567',
        codeString: '#3f7050',
        codeNumber: '#8a5a12',
        codeComment: '#9a8590',
        codeFunction: '#6b4aa0',
        codeType: '#2f6a7a',
        codeProperty: '#7a4a5e',
      },
      fonts: { display: 'Playfair Display', ui: 'Nunito' },
    },
  },
  {
    words: ['forest', 'moss', 'earth', 'woods', 'autumn', 'warm', 'cabin'],
    theme: {
      name: 'Forest Cabin',
      scheme: 'light',
      colors: {
        paper: '#eef0e6',
        paperRaised: '#f7f8f1',
        paperSunk: '#e2e6d6',
        ash: '#c9cfb8',
        ink: '#1f2a1d',
        inkSoft: '#4a5944',
        inkFaint: '#7a8873',
        accent: '#3f6b35',
        accentStrong: '#2f5527',
        glow: '#d99a3c',
        moss: '#4a6a3a',
        codeBg: '#e6eadb',
        codeKeyword: '#8a3b1d',
        codeString: '#3f6b35',
        codeNumber: '#8a5a12',
        codeComment: '#7a8873',
        codeFunction: '#5c4a1f',
        codeType: '#2f5f66',
        codeProperty: '#5a4a32',
      },
      fonts: { display: 'Fraunces', ui: 'Source Sans 3' },
    },
  },
]

/** The sample theme a description's words pick (else one chosen by the description's length). */
export function sampleThemeFor(prompt: string): Theme {
  const words = prompt.toLowerCase().split(/[^a-z]+/)
  const hit = SAMPLE_THEMES.find((s) => s.words.some((w) => words.includes(w)))
  const sample = hit ?? SAMPLE_THEMES[prompt.length % SAMPLE_THEMES.length]
  return fixContrast(sample?.theme ?? DEFAULT_LIGHT_THEME)
}
