import { afterEach, describe, expect, it } from 'vitest'
import { applyBrand } from '../brand/applyBrand'
import { chooseTheme, currentTheme, storedTheme, THEME_KEY } from './theme'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

const brand = (defaultTheme: 'system' | 'light' | 'dark') =>
  ({
    primary: '#c63d19',
    accent: '#ee9a46',
    neutral: 'warm',
    fonts: { choice: 'classic', display: 'Fraunces', ui: 'IBM Plex Sans' },
    defaultTheme,
    markUrl: null,
  }) as unknown as Parameters<typeof applyBrand>[0]

describe('theme choice', () => {
  it('applies light and dark on the page, and system clears it', () => {
    chooseTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(storedTheme()).toBe('dark')
    chooseTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    chooseTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem(THEME_KEY)).toBe('system')
  })

  it('lets the organization default apply until the member chooses, even “match my device”', () => {
    applyBrand(brand('dark'))
    expect(currentTheme()).toBe('dark')
    document.documentElement.removeAttribute('data-theme')
    chooseTheme('system')
    applyBrand(brand('dark'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(currentTheme()).toBe('system')
  })
})

describe('a theme of your own', () => {
  it('is painted from this browser’s copy, and forgotten when its copy is gone', async () => {
    const { DEFAULT_LIGHT_THEME } = await import('@hotsauce/format')
    const { applyTheme, CUSTOM_THEME_KEY } = await import('./theme')
    chooseTheme('custom:01ABC', { ...DEFAULT_LIGHT_THEME, name: 'Mine' })
    expect(document.documentElement.dataset.theme).toBe('custom')
    expect(storedTheme()).toBe('custom:01ABC')
    document.getElementById('hotsauce-custom-theme')?.remove()
    applyTheme('custom:01ABC')
    expect(document.getElementById('hotsauce-custom-theme')?.textContent).toContain('--paper')
    localStorage.removeItem(CUSTOM_THEME_KEY)
    expect(storedTheme()).toBeNull()
    applyTheme('custom:01ABC')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})
