import { CONTRAST_PAIRS, contrast } from '@hotsauce/format'
import { afterEach, describe, expect, it } from 'vitest'
import { chooseTheme, currentTheme, customChoice, THEME_KEY } from '../lib/theme'
import {
  BEFORE_HEAT_KEY,
  GHOST_PEPPER_ID,
  GHOST_PEPPER_THEME,
  isBuiltInThemeId,
  isGhostPepper,
  lessHeat,
  moreHeat,
} from './ghostPepper'

afterEach(() => {
  localStorage.clear()
  chooseTheme('system')
})

describe('Ghost Pepper (E3, E4)', () => {
  it('is readable: every colour pair meets its contrast ratio', () => {
    for (const pair of CONTRAST_PAIRS) {
      for (const bg of pair.on) {
        expect(
          contrast(GHOST_PEPPER_THEME.colors[pair.fg], GHOST_PEPPER_THEME.colors[bg]),
        ).toBeGreaterThanOrEqual(pair.ratio - 1e-9)
      }
    }
  })

  it('more heat turns it on and less heat puts the look from before back', () => {
    chooseTheme('light')
    moreHeat()
    expect(isGhostPepper()).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('custom')
    expect(document.documentElement.getAttribute('data-scheme')).toBe('dark')
    // Twice in a row still remembers the light look, not Ghost Pepper itself.
    moreHeat()
    expect(JSON.parse(localStorage.getItem(BEFORE_HEAT_KEY) ?? '{}')).toEqual({ choice: 'light' })
    lessHeat()
    expect(currentTheme()).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(localStorage.getItem(BEFORE_HEAT_KEY)).toBeNull()
  })

  it('from a theme of their own, cooling down puts that theme back, palette and all', () => {
    const own = { ...GHOST_PEPPER_THEME, name: 'Mine', scheme: 'light' as const }
    chooseTheme(customChoice('01ABC'), own)
    moreHeat()
    lessHeat()
    expect(currentTheme()).toBe('custom:01ABC')
    expect(document.documentElement.getAttribute('data-scheme')).toBe('light')
  })

  it('less heat changes nothing when Ghost Pepper is off', () => {
    chooseTheme('dark')
    lessHeat()
    expect(currentTheme()).toBe('dark')
  })

  it('is never mistaken for a deleted saved theme', () => {
    expect(isBuiltInThemeId(GHOST_PEPPER_ID)).toBe(true)
    expect(isBuiltInThemeId('01JABCDEF')).toBe(false)
  })
})
