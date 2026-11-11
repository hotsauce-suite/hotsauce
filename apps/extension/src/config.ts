// Fixed at build time (scripts/build.ts): the Hearth this copy of the extension talks to.

declare const __HEARTH_URL__: string
declare const __HEARTH_ORIGINS__: readonly string[]

/** Where "Take notes" opens, e.g. http://localhost:3000. */
export const HEARTH_URL: string = __HEARTH_URL__
/** Pages allowed to ask for a Meet tab's audio. */
export const HEARTH_ORIGINS: readonly string[] = __HEARTH_ORIGINS__

export function isHearthPage(url: string | undefined): boolean {
  if (!url) return false
  try {
    return HEARTH_ORIGINS.includes(new URL(url).origin)
  } catch {
    return false
  }
}
