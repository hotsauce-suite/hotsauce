import { afterEach, describe, expect, it } from 'vitest'
import type { PublicBrand } from '../api/types'
import { applyBrand, brandCss, fontHref } from './applyBrand'

const base: PublicBrand = {
  productName: 'Hotsauce',
  orgName: 'Acme',
  primary: '#c63d19',
  accent: '#ee9a46',
  neutral: 'warm',
  fonts: {
    choice: 'classic',
    label: 'Fraunces + IBM Plex Sans',
    display: 'Fraunces',
    ui: 'IBM Plex Sans',
  },
  defaultTheme: 'system',
  logoUrl: null,
  markUrl: null,
  voice: '',
  updatedAt: null,
}

afterEach(() => {
  document.getElementById('hotsauce-brand')?.remove()
  document.getElementById('hotsauce-brand-fonts')?.remove()
  document.documentElement.removeAttribute('data-theme')
})

describe('the brand kit in the app', () => {
  it('changes nothing for the default brand', () => {
    expect(brandCss(base)).toBe('')
    applyBrand(base)
    expect(document.getElementById('hotsauce-brand')).toBeNull()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('points the app tokens at the brand colors and fonts, in light and dark', () => {
    const css = brandCss({
      ...base,
      primary: '#1d4ed8',
      neutral: 'cool',
      fonts: { choice: 'modern', label: '', display: 'Space Grotesk', ui: 'Inter' },
    })
    expect(css).toContain('--ember: #1d4ed8;')
    expect(css).toContain('--brand-primary: #1d4ed8;')
    expect(css).toContain('--paper: #eef1f5;')
    expect(css).toContain('--type-display: "Space Grotesk"')
    expect(css).toContain(':root[data-theme="dark"]')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
  })

  it('scopes the preview to its own box', () => {
    const css = brandCss({ ...base, primary: '#16a34a' }, '.brand-preview')
    expect(css).not.toContain(':root')
    expect(css).toContain('.brand-preview {')
  })

  it('loads the chosen fonts once and applies the organization’s default look', () => {
    applyBrand({
      ...base,
      primary: '#16a34a',
      defaultTheme: 'dark',
      fonts: { choice: 'modern', label: '', display: 'Space Grotesk', ui: 'Inter' },
    })
    expect(document.getElementById('hotsauce-brand')?.textContent).toContain('#16a34a')
    expect((document.getElementById('hotsauce-brand-fonts') as HTMLLinkElement).href).toBe(
      fontHref('Space Grotesk', 'Inter'),
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
