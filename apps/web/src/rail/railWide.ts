// Whether the desktop rail is wide (each icon beside its name) or narrow (docs/PLAN-rail-account-menu.md,
// requirements 1 and 2). Kept per device: a laptop can stay wide while a small window stays narrow.
// `<html data-rail="wide">` widens `--rail-width` (tokens.css), which everything beside the rail follows.

import { useSyncExternalStore } from 'react'

export const RAIL_KEY = 'hotsauce:rail'

const listeners = new Set<() => void>()

function stored(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'wide'
  } catch {
    return false
  }
}

let wide = stored()

function paint(): void {
  if (wide) document.documentElement.setAttribute('data-rail', 'wide')
  else document.documentElement.removeAttribute('data-rail')
}
paint()

export function railIsWide(): boolean {
  return wide
}

export function setRailWide(next: boolean): void {
  wide = next
  try {
    if (next) localStorage.setItem(RAIL_KEY, 'wide')
    else localStorage.removeItem(RAIL_KEY)
  } catch {
    // No storage (private window): it lasts until the page reloads.
  }
  paint()
  for (const listener of listeners) listener()
}

/** Reads the stored choice again (tests). */
export function reloadRailWide(): void {
  wide = stored()
  paint()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRailWide(): boolean {
  return useSyncExternalStore(subscribe, railIsWide, railIsWide)
}
