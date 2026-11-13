// The member's keyboard choice, kept in this browser: whether single-key shortcuts (letters,
// digits, symbols, Space) work. On by default; Settings turns them off (WCAG 2.1.4), for
// people whose voice control or switch device types letters that shouldn't run commands.

import { useSyncExternalStore } from 'react'

export const SINGLE_KEYS_KEY = 'hearth:single-keys'

const listeners = new Set<() => void>()

export function singleKeysOn(): boolean {
  try {
    return localStorage.getItem(SINGLE_KEYS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSingleKeys(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SINGLE_KEYS_KEY)
    else localStorage.setItem(SINGLE_KEYS_KEY, 'off')
  } catch {
    // No storage: the choice lasts until the page reloads.
    memory = on
  }
  for (const listener of listeners) listener()
}

let memory: boolean | null = null

function read(): boolean {
  return memory ?? singleKeysOn()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSingleKeys(): boolean {
  return useSyncExternalStore(subscribe, read, () => true)
}

/** For the key listener, which reads it on every key. */
export const singleKeysEnabled = read
