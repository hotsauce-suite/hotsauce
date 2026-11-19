// Each member's own look, kept in this browser: light, dark, the system's, or one of their own
// themes (docs/PLAN-ai-themes.md). The tokens in tokens.css follow the system unless
// `<html data-theme>` says otherwise; the organization's default look (applyBrand) applies only
// until the member picks one here. index.html applies the stored choice before the first paint, so
// a dark-mode member never sees a flash of light, nor a member with their own theme a flash of
// Hotsauce's.

import { type Theme, themeCss, themeFontsHref } from '@hotsauce/format'
import { sunPlace, sunScheme } from '../apps/today/sky/followSun'

/** `sun`: light from sunrise to sunset, dark otherwise (docs/PLAN-today-sky.md R9). */
export type ThemeChoice = 'system' | 'light' | 'dark' | 'sun' | `custom:${string}`

export const THEME_KEY = 'hearth:theme'
/** The member's own theme in use here, ready to paint: `{ id, css, fonts }` (index.html reads it). */
export const CUSTOM_THEME_KEY = 'hotsauce:custom-theme'
/** Under "Follow the sun", the look last worked out, so index.html paints it before the first frame. */
export const SUN_SCHEME_KEY = 'hotsauce:sun-scheme'
const STYLE_ID = 'hotsauce-custom-theme'
const FONTS_ID = 'hotsauce-custom-theme-fonts'

interface CachedTheme {
  id: string
  css: string
  fonts: string
  scheme: Theme['scheme']
}

function cached(): CachedTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<CachedTheme>
    return typeof value.id === 'string' &&
      typeof value.css === 'string' &&
      typeof value.fonts === 'string' &&
      (value.scheme === 'light' || value.scheme === 'dark')
      ? (value as CachedTheme)
      : null
  } catch {
    return null
  }
}

/** Sent on `window` whenever a look is chosen, so every switch on screen shows the same one. */
export const THEME_CHOSEN = 'hotsauce:theme-chosen'

export const customChoice = (id: string): ThemeChoice => `custom:${id}`
export const customIdOf = (choice: ThemeChoice): string | null =>
  choice.startsWith('custom:') ? choice.slice('custom:'.length) : null

/** What this browser chose, or null when it never chose (the organization's default applies). */
export function storedTheme(): ThemeChoice | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    if (value === 'system' || value === 'light' || value === 'dark' || value === 'sun') return value
    // One of the member's own themes, if this browser still has it ready to paint.
    if (value?.startsWith('custom:') && cached()?.id === value.slice('custom:'.length)) {
      return value as ThemeChoice
    }
    return null
  } catch {
    return null
  }
}

/** Remembers the choice and applies it at once. A theme of their own comes with its palette. */
export function chooseTheme(choice: ThemeChoice, theme?: Theme): void {
  const id = customIdOf(choice)
  try {
    if (id && theme) {
      const entry: CachedTheme = {
        id,
        css: themeCss(theme),
        fonts: themeFontsHref(theme),
        scheme: theme.scheme,
      }
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(entry))
    }
    if (!id) localStorage.removeItem(CUSTOM_THEME_KEY)
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    // No storage (private window): the choice lasts until the page reloads.
  }
  if (id && theme) paintCustom(themeCss(theme), themeFontsHref(theme), theme.scheme)
  applyTheme(choice)
  window.dispatchEvent(new Event(THEME_CHOSEN))
}

/** `data-scheme` tells styles and Boards whether the theme is a light or a dark one. */
function paintCustom(css: string, fonts: string, scheme: Theme['scheme']): void {
  document.documentElement.setAttribute('data-scheme', scheme)
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.append(style)
  }
  style.textContent = css
  let link = document.getElementById(FONTS_ID) as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = FONTS_ID
    link.rel = 'stylesheet'
    document.head.append(link)
  }
  if (link.href !== fonts) link.href = fonts
}

function unpaintCustom(): void {
  document.documentElement.removeAttribute('data-scheme')
  document.getElementById(STYLE_ID)?.remove()
  document.getElementById(FONTS_ID)?.remove()
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  const id = customIdOf(choice)
  if (id) {
    const entry = cached()
    if (entry?.id === id) {
      if (!document.getElementById(STYLE_ID)) paintCustom(entry.css, entry.fonts, entry.scheme)
      root.setAttribute('data-theme', 'custom')
    } else {
      // The palette isn't here (storage was cleared): show the system's look.
      unpaintCustom()
      root.removeAttribute('data-theme')
    }
  } else {
    unpaintCustom()
    if (choice === 'system') root.removeAttribute('data-theme')
    else if (choice === 'sun') root.setAttribute('data-theme', followTheSun())
    else root.setAttribute('data-theme', choice)
  }
  if (choice === 'sun') startSunWatch()
  else stopSunWatch()
  syncBrowserBar(choice === 'system')
}

/** Light or dark for now under "Follow the sun", remembered for the next first paint. */
function followTheSun(now = new Date()): 'light' | 'dark' {
  const scheme = sunScheme(now, sunPlace())
  try {
    localStorage.setItem(SUN_SCHEME_KEY, scheme)
  } catch {
    // No storage: worked out again on the next load.
  }
  return scheme
}

let sunWatch: ReturnType<typeof setInterval> | undefined

/** Checks once a minute (and on waking) whether the sun has risen or set. */
function startSunWatch(): void {
  if (sunWatch !== undefined) return
  const check = () => {
    if (storedTheme() !== 'sun') return stopSunWatch()
    const root = document.documentElement
    // A theme being tried in Settings stays up until Keep or Discard.
    if (root.getAttribute('data-theme') === 'custom') return
    const scheme = followTheSun()
    if (root.getAttribute('data-theme') !== scheme) {
      root.setAttribute('data-theme', scheme)
      syncBrowserBar(false)
    }
  }
  sunWatch = setInterval(check, 60_000)
  document.addEventListener('visibilitychange', check)
  sunWatchCheck = check
}

let sunWatchCheck: (() => void) | undefined

function stopSunWatch(): void {
  if (sunWatch === undefined) return
  clearInterval(sunWatch)
  sunWatch = undefined
  if (sunWatchCheck) document.removeEventListener('visibilitychange', sunWatchCheck)
  sunWatchCheck = undefined
}

/** The browser's own bar (and the installed app's title bar) follows the page's paper colour. */
function syncBrowserBar(system: boolean): void {
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.system ??= meta.content
    meta.content = system || !paper ? meta.dataset.system : paper
  }
}

/**
 * Shows a theme across the whole app without keeping it (the preview before Keep or Discard).
 * `endPreview` puts back the member's choice.
 */
export function previewTheme(theme: Theme): void {
  paintCustom(themeCss(theme), themeFontsHref(theme), theme.scheme)
  document.documentElement.setAttribute('data-theme', 'custom')
  syncBrowserBar(false)
}

export function endPreview(): void {
  unpaintCustom()
  applyTheme(currentTheme())
}

/** The choice in effect now: stored, else what the page shows (the org default), else system. */
export function currentTheme(): ThemeChoice {
  const stored = storedTheme()
  if (stored) return stored
  const shown = document.documentElement.getAttribute('data-theme')
  return shown === 'light' || shown === 'dark' ? shown : 'system'
}
