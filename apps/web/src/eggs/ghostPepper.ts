// The hidden Ghost Pepper theme (docs/PLAN-easter-eggs.md E3, E4): "more heat" in ⌘K turns it on,
// "less heat" puts back the look from before. It rides on the member-theme machinery (lib/theme)
// under a fixed id no saved theme can have (saved ids are ULIDs).

import { fixContrast, type Theme } from '@hotsauce/format'
import { chooseTheme, currentTheme, customChoice, customIdOf, type ThemeChoice } from '../lib/theme'

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

/** Turns on Ghost Pepper, remembering the look in use unless it already is Ghost Pepper. */
export function moreHeat(): void {
  const before = currentTheme()
  if (!isGhostPepper(before)) {
    try {
      // A theme of the member's own can't be put back from here (its palette comes from the
      // account), so remember the light or dark it was and fall back to the device's look.
      localStorage.setItem(BEFORE_HEAT_KEY, customIdOf(before) ? 'system' : before)
    } catch {}
  }
  chooseTheme(customChoice(GHOST_PEPPER_ID), GHOST_PEPPER_THEME)
}

/** Puts back the look from before More heat (the device's look if none was remembered). */
export function lessHeat(): void {
  let before: ThemeChoice = 'system'
  try {
    const saved = localStorage.getItem(BEFORE_HEAT_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') before = saved
    localStorage.removeItem(BEFORE_HEAT_KEY)
  } catch {}
  chooseTheme(before)
}
