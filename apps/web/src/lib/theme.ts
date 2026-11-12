// Each member's own light or dark choice, kept in this browser. The tokens in tokens.css follow
// the system unless `<html data-theme>` says otherwise; the organization's default look
// (applyBrand) applies only until the member picks one here. index.html applies the stored
// choice before the first paint, so a dark-mode member never sees a flash of light.

export type ThemeChoice = 'system' | 'light' | 'dark'

export const THEME_KEY = 'hearth:theme'

/** What this browser chose, or null when it never chose (the organization's default applies). */
export function storedTheme(): ThemeChoice | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'system' || value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** Remembers the choice and applies it at once. */
export function chooseTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    // No storage (private window): the choice lasts until the page reloads.
  }
  applyTheme(choice)
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  // The browser's own bar (and the installed app's title bar) follows the page's paper colour.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.system ??= meta.content
    meta.content = choice === 'system' || !paper ? meta.dataset.system : paper
  }
}

/** The choice in effect now: stored, else what the page shows (the org default), else system. */
export function currentTheme(): ThemeChoice {
  const stored = storedTheme()
  if (stored) return stored
  const shown = document.documentElement.getAttribute('data-theme')
  return shown === 'light' || shown === 'dark' ? shown : 'system'
}
