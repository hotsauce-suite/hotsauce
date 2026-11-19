// The small touches in the left bar (docs/PLAN-rail-account-menu.md, requirement 17): the pepper
// at its foot and the logo's wobble. On unless the member turns them off in Settings →
// Appearance; the choice is kept per browser. Anything that moves also stops when the device
// asks for less motion.

import { useSyncExternalStore } from 'react'

export const DELIGHT_KEY = 'hotsauce:delight'

/** Sent on `window` when something worth a little hop happened (a task done, a recording saved). */
export const CHEER = 'hotsauce:cheer'

const listeners = new Set<() => void>()

/** The choice when storage can't hold it (a private window): it lasts until the page reloads. */
let unsaved: boolean | null = null

export function delightOn(): boolean {
  if (unsaved !== null) return unsaved
  try {
    return localStorage.getItem(DELIGHT_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Styles read this too: the logo keeps still when it is off. */
function paint(): void {
  if (delightOn()) document.documentElement.removeAttribute('data-delight')
  else document.documentElement.setAttribute('data-delight', 'off')
}

export function setDelight(on: boolean): void {
  try {
    if (on) localStorage.removeItem(DELIGHT_KEY)
    else localStorage.setItem(DELIGHT_KEY, 'off')
    unsaved = null
  } catch {
    unsaved = on
  }
  paint()
  for (const listener of listeners) listener()
}

/** Reads the choice again (tests, after storage was cleared). */
export function reloadDelight(): void {
  unsaved = null
  paint()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDelight(): boolean {
  return useSyncExternalStore(subscribe, delightOn)
}

/** Something went well: the pepper hops, if it is there to. Never throws. */
export function cheer(): void {
  try {
    window.dispatchEvent(new Event(CHEER))
  } catch {
    // Nothing to cheer in (a worker, a test without a window).
  }
}

/** The device asks for less motion. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

if (typeof document !== 'undefined') paint()
