// The apps each member pins to the desktop rail (docs/PLAN-pinned-rail.md). The server keeps the
// list per member (GET/PUT /api/pins); this browser keeps a copy so the rail draws the right apps
// before the server answers. Every app, pinned or not, is in the launcher.

import { useSyncExternalStore } from 'react'
import { api } from '../api/client'
import { APPS, type AppManifest, type RailLink, railLinks } from './registry'

/** What a new member's rail shows. Chat shows only where the organization added a chat link. */
export const DEFAULT_PINS: readonly string[] = ['today', 'docs', 'tasks', 'meetings', 'chat']

/** Most apps the rail holds (the server's `MAX_PINS`). */
export const MAX_PINS = 6

const CACHE_KEY = 'hearth.pins'

export type RailEntry = { kind: 'app'; app: AppManifest } | { kind: 'link'; link: RailLink }

export function entryId(entry: RailEntry): string {
  return entry.kind === 'app' ? entry.app.id : entry.link.id
}

/** Every app, then the organization's links: what the launcher lists, in this order. */
export function allEntries(): RailEntry[] {
  return [
    ...APPS.map((app) => ({ kind: 'app' as const, app })),
    ...railLinks().map((link) => ({ kind: 'link' as const, link })),
  ]
}

/** The pinned ids as entries, in order; ids of apps this instance doesn't have are skipped. */
export function pinnedEntries(pins: readonly string[]): RailEntry[] {
  const all = allEntries()
  return pins.flatMap((id) => all.filter((entry) => entryId(entry) === id))
}

function readCache(): readonly string[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
  } catch {
    return null
  }
}

function writeCache(pins: readonly string[] | null): void {
  try {
    if (pins) localStorage.setItem(CACHE_KEY, JSON.stringify(pins))
    else localStorage.removeItem(CACHE_KEY)
  } catch {
    // Private windows may refuse storage; the server still has the list.
  }
}

let current: readonly string[] | null = null
let fetched = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function load(): void {
  if (fetched) return
  fetched = true
  current ??= readCache()
  void api
    .pins()
    .then(({ pins }) => {
      current = pins
      writeCache(pins)
      emit()
    })
    .catch(() => {
      // Offline or signed out mid-load: keep what the cache had, and try again next time.
      fetched = false
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  load()
  return () => listeners.delete(listener)
}

function snapshot(): readonly string[] {
  return current ?? DEFAULT_PINS
}

/** The member's pinned ids, in rail order (the defaults until they change them). */
export function usePins(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Saves a new pinned list: the rail follows at once, the server a moment later. */
export async function savePins(pins: readonly string[]): Promise<void> {
  const next = [...new Set(pins)].slice(0, MAX_PINS)
  const before = current
  current = next
  writeCache(next)
  emit()
  try {
    await api.setPins(next)
  } catch (err) {
    current = before
    writeCache(before)
    emit()
    throw err
  }
}

/** Forgets this member's pins (at sign-out, so the next member starts from their own). */
export function forgetPins(): void {
  current = null
  fetched = false
  writeCache(null)
  emit()
}
