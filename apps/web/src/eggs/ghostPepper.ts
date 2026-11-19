// The hidden Ghost Pepper theme (docs/PLAN-easter-eggs.md E3, E4): "more heat" in ⌘K turns it on,
// "less heat" puts back the look from before. It rides on the member-theme machinery (lib/theme)
// under a fixed id no saved theme can have (saved ids are ULIDs).

import { fixContrast, type Theme } from '@hotsauce/format'
import {
  CUSTOM_THEME_KEY,
  chooseTheme,
  currentTheme,
  customChoice,
  customIdOf,
  storedTheme,
  THEME_KEY,
  type ThemeChoice,
} from '../lib/theme'

export const GHOST_PEPPER_ID = 'ghost-pepper'
/** The look before More heat, so Less heat can put it back. */
export const BEFORE_HEAT_KEY = 'hotsauce:before-heat'

export const GHOST_PEPPER_THEME: Theme = fixContrast({
  name: 'Ghost Pepper',
  scheme: 'dark',
  colors: {
    paper: '#1a0f0d',
    paperRaised: '#241512',
    paperSunk: '#140b09',
    ash: '#3d2620',
    ink: '#f7e6dc',
    inkSoft: '#d1b2a3',
    inkFaint: '#9c7d70',
    accent: '#ff5a2c',
    accentStrong: '#ff8a5c',
    glow: '#ffb347',
    moss: '#9ccf6a',
    codeBg: '#211310',
    codeKeyword: '#ff7a59',
    codeString: '#b6d77a',
    codeNumber: '#ffc061',
    codeComment: '#8c6f63',
    codeFunction: '#ff9f6e',
    codeType: '#f2c46d',
    codeProperty: '#e6a3c4',
  },
  fonts: { display: 'Fraunces', ui: 'IBM Plex Sans' },
})

export function isGhostPepper(choice: ThemeChoice = currentTheme()): boolean {
  return customIdOf(choice) === GHOST_PEPPER_ID
}

/** True for a theme id that lives in the app, not the account, so it is never "deleted". */
export const isBuiltInThemeId = (id: string): boolean => id === GHOST_PEPPER_ID

interface BeforeHeat {
  /** The choice in use, or null when this browser never chose (the organization's look). */
  choice: ThemeChoice | null
  /** A member's own theme's palette, ready to paint again (lib/theme's cache entry). */
  palette?: string
}

/** Turns on Ghost Pepper, remembering the look in use unless it already is Ghost Pepper. */
export function moreHeat(): void {
  if (!isGhostPepper()) {
    try {
      const choice = storedTheme()
      const before: BeforeHeat = { choice }
      if (choice && customIdOf(choice)) {
        const palette = localStorage.getItem(CUSTOM_THEME_KEY)
        if (palette) before.palette = palette
      }
      localStorage.setItem(BEFORE_HEAT_KEY, JSON.stringify(before))
    } catch {}
  }
  chooseTheme(customChoice(GHOST_PEPPER_ID), GHOST_PEPPER_THEME)
}

function readBefore(): BeforeHeat | null {
  try {
    const raw = localStorage.getItem(BEFORE_HEAT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as BeforeHeat
    const c = value.choice
    if (c === null || c === 'light' || c === 'dark' || c === 'system') return { choice: c }
    if (typeof c === 'string' && c.startsWith('custom:') && typeof value.palette === 'string') {
      return { choice: c, palette: value.palette }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Puts back the look from before More heat (the device's look if none was remembered). Does
 * nothing unless Ghost Pepper is on, so a curious "less heat" never changes someone's look.
 */
export function lessHeat(): void {
  if (!isGhostPepper()) return
  const before = readBefore()
  try {
    localStorage.removeItem(BEFORE_HEAT_KEY)
  } catch {}
  if (before?.palette && before.choice) {
    // Off first, so the theme's own palette is painted again rather than Ghost Pepper's.
    chooseTheme('system')
    try {
      localStorage.setItem(CUSTOM_THEME_KEY, before.palette)
    } catch {}
    chooseTheme(before.choice)
    return
  }
  chooseTheme(before?.choice ?? 'system')
  if (before && before.choice === null) {
    // They never chose: the organization's look comes back with the next page load.
    try {
      localStorage.removeItem(THEME_KEY)
    } catch {}
  }
}
