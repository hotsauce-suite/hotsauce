import type { PublicBrand } from '../api/types'

/**
 * Turns the organization's brand kit into the app's look (ARCHITECTURE §11.3): `--brand-*`
 * variables for anything new, and the existing tokens (ember, glow, fonts) pointed at them. The
 * default brand changes nothing, so an instance that never set one looks exactly as before.
 */

const DEFAULT = { primary: '#c63d19', accent: '#ee9a46', fonts: 'classic', neutral: 'warm' }
const STYLE_ID = 'hotsauce-brand'
const FONT_LINK_ID = 'hotsauce-brand-fonts'

const NEUTRALS: Record<
  'cool' | 'gray',
  { light: Record<string, string>; dark: Record<string, string> }
> = {
  cool: {
    light: {
      paper: '#eef1f5',
      'paper-raised': '#f8fafc',
      'paper-sunk': '#e3e8ef',
      ash: '#cdd5df',
      ink: '#18202b',
      'ink-soft': '#4a5566',
      'ink-faint': '#7b8696',
    },
    dark: {
      paper: '#131820',
      'paper-raised': '#1b222c',
      'paper-sunk': '#0e1218',
      ash: '#2c3542',
      ink: '#e6ebf1',
      'ink-soft': '#a9b3c1',
      'ink-faint': '#788394',
    },
  },
  gray: {
    light: {
      paper: '#f1f1f0',
      'paper-raised': '#fafafa',
      'paper-sunk': '#e6e6e4',
      ash: '#d0d0cd',
      ink: '#1e1e1d',
      'ink-soft': '#525250',
      'ink-faint': '#85857f',
    },
    dark: {
      paper: '#161616',
      'paper-raised': '#1f1f1f',
      'paper-sunk': '#101010',
      ash: '#333333',
      ink: '#ececec',
      'ink-soft': '#b0b0b0',
      'ink-faint': '#808080',
    },
  },
}

function vars(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `--${k}: ${v};`)
    .join(' ')
}

/** The CSS for a brand, or '' for the default one. Exported for tests and the wizard preview. */
export function brandCss(
  brand: Pick<PublicBrand, 'primary' | 'accent' | 'neutral' | 'fonts'>,
  scope = ':root',
): string {
  const isDefault =
    brand.primary.toLowerCase() === DEFAULT.primary &&
    brand.accent.toLowerCase() === DEFAULT.accent &&
    brand.fonts.choice === DEFAULT.fonts &&
    brand.neutral === DEFAULT.neutral
  if (isDefault) return ''
  const p = brand.primary
  const a = brand.accent
  const light = {
    'brand-primary': p,
    'brand-accent': a,
    ember: p,
    'ember-strong': `color-mix(in oklab, ${p} 82%, black)`,
    'ember-wash': `color-mix(in oklab, ${p} 10%, transparent)`,
    glow: a,
    'focus-ring': `0 0 0 2px var(--paper), 0 0 0 4px color-mix(in oklab, ${p} 55%, transparent)`,
    ...(brand.neutral !== 'warm' ? NEUTRALS[brand.neutral].light : {}),
  }
  // Dark backgrounds need a lighter primary to keep contrast.
  const pd = `color-mix(in oklab, ${p} 72%, white)`
  const dark = {
    'brand-primary': pd,
    'brand-accent': a,
    ember: pd,
    'ember-strong': `color-mix(in oklab, ${p} 55%, white)`,
    'ember-wash': `color-mix(in oklab, ${pd} 13%, transparent)`,
    glow: a,
    'focus-ring': `0 0 0 2px var(--paper), 0 0 0 4px color-mix(in oklab, ${pd} 60%, transparent)`,
    ...(brand.neutral !== 'warm' ? NEUTRALS[brand.neutral].dark : {}),
  }
  const fonts =
    brand.fonts.choice === DEFAULT.fonts
      ? ''
      : `--type-display: "${brand.fonts.display}", ui-serif, Georgia, serif; --type-ui: "${brand.fonts.ui}", ui-sans-serif, system-ui, sans-serif;`
  const root = scope === ':root'
  const darkSel = root ? ':root:not([data-theme="light"])' : `${scope}`
  return [
    `${scope} { ${vars(light)} ${fonts} }`,
    `@media (prefers-color-scheme: dark) { ${darkSel} { ${vars(dark)} } }`,
    root ? `:root[data-theme="dark"] { ${vars(dark)} }` : '',
  ].join('\n')
}

export function fontHref(display: string, ui: string): string {
  const fam = (f: string) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700`
  const names = [...new Set([display, ui])]
  return `https://fonts.googleapis.com/css2?${names.map(fam).join('&')}&display=swap`
}

export function ensureFonts(display: string, ui: string): void {
  if (display === 'Fraunces' && ui === 'IBM Plex Sans') return
  const href = fontHref(display, ui)
  let link = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = FONT_LINK_ID
    link.rel = 'stylesheet'
    document.head.appendChild(link)
  }
  if (link.href !== href) link.href = href
}

export function applyBrand(brand: PublicBrand | null | undefined): void {
  if (!brand) return
  const css = brandCss(brand)
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (css) {
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = css
    ensureFonts(brand.fonts.display, brand.fonts.ui)
  } else if (style) {
    style.remove()
  }
  if (brand.markUrl) {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
      link.href = brand.markUrl
      link.removeAttribute('type')
    }
  }
  // The organization's default, unless this browser already chose a theme.
  const root = document.documentElement
  if (brand.defaultTheme !== 'system' && !root.hasAttribute('data-theme')) {
    let chosen: string | null = null
    try {
      chosen = localStorage.getItem('hearth:theme')
    } catch {
      // No storage.
    }
    if (!chosen) root.setAttribute('data-theme', brand.defaultTheme)
  }
}
