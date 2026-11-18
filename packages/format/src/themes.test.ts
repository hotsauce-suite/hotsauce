import { describe, expect, it } from 'vitest'
import {
  CONTRAST_PAIRS,
  contrast,
  DEFAULT_LIGHT_THEME,
  fixContrast,
  parseTheme,
  readableOn,
  Theme,
  themeCss,
  themeFontsHref,
  themeTokens,
} from './themes.js'

const dusk: Theme = {
  name: 'Dusk',
  scheme: 'dark',
  colors: {
    ...DEFAULT_LIGHT_THEME.colors,
    paper: '#1b1d2e',
    paperRaised: '#24273b',
    paperSunk: '#15172a',
    codeBg: '#1f2133',
    ink: '#555555', // far too dark on that paper
    inkSoft: '#444444',
    inkFaint: '#333333',
  },
  fonts: { display: 'Space Grotesk', ui: 'Inter' },
}

function passes(theme: Theme): boolean {
  return CONTRAST_PAIRS.every((p) =>
    p.on.every((bg) => contrast(theme.colors[p.fg], theme.colors[bg]) >= p.ratio - 1e-9),
  )
}

describe('contrast', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#c63d19', '#c63d19')).toBe(1)
  })
})

describe('readableOn (R4)', () => {
  it('leaves a readable colour alone', () => {
    expect(readableOn('#000000', ['#ffffff'], 4.5)).toBe('#000000')
  })
  it('lightens text on a dark background until it reads', () => {
    const fixed = readableOn('#444444', ['#111111'], 4.5)
    expect(contrast(fixed, '#111111')).toBeGreaterThanOrEqual(4.5)
  })
  it('darkens text on a light background, keeping some of its hue', () => {
    const fixed = readableOn('#ff9900', ['#ffffff'], 4.5)
    expect(contrast(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(fixed).not.toBe('#000000')
  })
})

describe('fixContrast (R4)', () => {
  it('makes an unreadable dark theme readable', () => {
    expect(passes(dusk)).toBe(false)
    expect(passes(fixContrast(dusk))).toBe(true)
  })
  it("leaves Hotsauce's own light look almost as it is", () => {
    const fixed = fixContrast(DEFAULT_LIGHT_THEME)
    expect(passes(fixed)).toBe(true)
    expect(fixed.colors.paper).toBe(DEFAULT_LIGHT_THEME.colors.paper)
  })
  it('pushes a light theme with a mid-grey paper lighter', () => {
    const grey = fixContrast({
      ...DEFAULT_LIGHT_THEME,
      colors: { ...DEFAULT_LIGHT_THEME.colors, paper: '#777777' },
    })
    expect(passes(grey)).toBe(true)
  })
})

describe('parseTheme (R3)', () => {
  it('reads the JSON inside <theme>, normalising colours', () => {
    const json = JSON.stringify({ ...dusk, colors: { ...dusk.colors, glow: 'FFAA00' } })
    const theme = parseTheme(`Here you go\n<theme>${json}</theme>`)
    expect(theme?.name).toBe('Dusk')
    expect(theme?.colors.glow).toBe('#ffaa00')
    expect(theme && passes(theme)).toBe(true)
  })
  it('refuses anything that is not a theme', () => {
    expect(parseTheme('no')).toBeNull()
    expect(parseTheme('<theme>{"name": "x"}</theme>')).toBeNull()
    expect(parseTheme('<theme>{not json}</theme>')).toBeNull()
  })
  it('swaps a font name that could break out of CSS for a safe one (R7)', () => {
    const bad = { ...dusk, fonts: { display: 'Inter"; } body { x', ui: 'Inter' } }
    expect(parseTheme(`<theme>${JSON.stringify(bad)}</theme>`)?.fonts.display).toBe('Fraunces')
    expect(Theme.safeParse(bad).success).toBe(false)
  })
  it('forgives short colours and long names', () => {
    const loose = {
      ...dusk,
      name: 'A Very Long Theme Name That Goes On And On Forever',
      colors: { ...dusk.colors, glow: '#fa0' },
    }
    const theme = parseTheme(`<theme>${JSON.stringify(loose)}</theme>`)
    expect(theme?.colors.glow).toBe('#ffaa00')
    expect(theme?.name.length).toBeLessThanOrEqual(40)
  })
})

describe('themeCss', () => {
  it('scopes every token to data-theme="custom" and sets the scheme', () => {
    const css = themeCss(fixContrast(dusk))
    expect(css.startsWith('html:root[data-theme="custom"] {')).toBe(true)
    expect(css).toContain('color-scheme: dark;')
    expect(css).toContain('--type-ui: "Inter"')
  })
  it('covers every colour token tokens.css defines', () => {
    const tokens = Object.keys(themeTokens(dusk))
    for (const name of [
      '--paper',
      '--paper-raised',
      '--paper-sunk',
      '--ash',
      '--ash-strong',
      '--ink',
      '--ink-soft',
      '--ink-faint',
      '--ink-ai',
      '--ember',
      '--ember-strong',
      '--ember-wash',
      '--glow',
      '--moss',
      '--moss-wash',
      '--rust-wash',
      '--code-bg',
      '--select-chevron',
      '--shadow-float',
      '--focus-ring',
    ]) {
      expect(tokens).toContain(name)
    }
  })
  it('links both fonts once', () => {
    expect(themeFontsHref(dusk)).toBe(
      'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap',
    )
  })
})

describe('sample themes (R11)', () => {
  it('are picked by the words in a description and read well', async () => {
    const { sampleThemeFor } = await import('./themes.js')
    expect(sampleThemeFor('a dark midnight look').name).toBe('Midnight Harbor')
    expect(sampleThemeFor('Retro terminal please').scheme).toBe('dark')
    expect(passes(sampleThemeFor('something soft and pastel'))).toBe(true)
    expect(sampleThemeFor('zzz').name).toBeTruthy()
  })
})
