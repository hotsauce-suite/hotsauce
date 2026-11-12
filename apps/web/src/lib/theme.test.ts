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
