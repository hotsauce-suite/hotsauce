// The apps each member pins to the desktop rail (docs/PLAN-pinned-rail.md), and the apps they
// chose for the phone's tab bar (docs/PLAN-phone-tab-bar.md): two separate lists. The server keeps
// each per member (GET/PUT /api/pins and /api/phone-pins); this browser keeps a copy so the bar
// draws the right apps before the server answers. Every app, pinned or not, is in the launcher and
// the Apps sheet.

import { useSyncExternalStore } from 'react'
import { api } from '../api/client'
import { APPS, type AppManifest, type RailLink, railLinks } from './registry'

/** What a new member's rail shows. Chat shows only where the organization added a chat link. */
export const DEFAULT_PINS: readonly string[] = [
  'today',
  'for-you',
  'docs',
  'tasks',
  'meetings',
  'chat',
]

/** What a new member's phone tab bar shows, before the Apps tab. */
export const DEFAULT_PHONE_PINS: readonly string[] = ['today', 'docs', 'tasks', 'meetings']

/** The phone's tab bar holds this many apps beside Apps (the server holds it there too). */
export const MAX_PHONE_PINS = 5

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

/** One member list of app ids, kept on the server with a copy in this browser. */
function pinList(options: {
  cacheKey: string
  defaults: readonly string[]
  load: () => Promise<{ pins: string[] | null }>
  save: (pins: readonly string[]) => Promise<unknown>
}) {
  const readCache = (): readonly string[] | null => {
    try {
      const raw = localStorage.getItem(options.cacheKey)
      const value: unknown = raw ? JSON.parse(raw) : null
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
    } catch {
      return null
    }
  }

  const writeCache = (pins: readonly string[] | null): void => {
    try {
      if (pins) localStorage.setItem(options.cacheKey, JSON.stringify(pins))
      else localStorage.removeItem(options.cacheKey)
    } catch {
      // Private windows may refuse storage; the server still has the list.
    }
  }

  let current: readonly string[] | null = null
  let fetched = false
  // Bumped by every save and by sign-out, so an answer that arrives after either is dropped.
  let generation = 0
  // Saves go to the server one at a time, in click order.
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const load = (): void => {
    if (fetched) return
    fetched = true
    current ??= readCache()
    const asked = generation
    void options
      .load()
      .then(({ pins }) => {
        if (asked !== generation) return
        current = pins
        writeCache(pins)
        emit()
      })
      .catch(() => {
        // Offline or signed out mid-load: keep what the cache had, and try again next time.
        if (asked === generation) fetched = false
      })
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    load()
    return () => listeners.delete(listener)
  }

  // For a component that may not need the list: listens without asking the server.
  const listen = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const snapshot = (): readonly string[] => current ?? options.defaults

  return {
    use: (fetch = true): readonly string[] =>
      useSyncExternalStore(fetch ? subscribe : listen, snapshot, snapshot),

    save(pins: readonly string[]): Promise<void> {
      const next = [...new Set(pins)]
      const mine = ++generation
      current = next
      writeCache(next)
      emit()
      const saved = queue.then(() => options.save(next))
      queue = saved.catch(() => {})
      return saved.then(
        () => {},
        async (err) => {
          if (mine === generation) {
            const { pins: theirs } = await options.load().catch(() => ({ pins: current }))
            if (mine === generation) {
              current = theirs
              writeCache(theirs)
              emit()
            }
          }
          throw err
        },
      )
    },

    forget(): void {
      generation++
      current = null
      fetched = false
      writeCache(null)
      emit()
    },
  }
}

const rail = pinList({
  cacheKey: 'hearth.pins',
  defaults: DEFAULT_PINS,
  load: () => api.pins(),
  save: (pins) => api.setPins(pins),
})

const phone = pinList({
  cacheKey: 'hotsauce.phone-pins',
  defaults: DEFAULT_PHONE_PINS,
  load: () => api.phonePins(),
  save: (pins) => api.setPhonePins(pins),
})

/** The member's pinned ids, in rail order (the defaults until they change them). */
export function usePins(): readonly string[] {
  return rail.use()
}

/**
 * Saves a new pinned list: the rail follows at once, the server a moment later. If the server
 * refuses, the rail goes back to what the server has.
 */
export function savePins(pins: readonly string[]): Promise<void> {
  return rail.save(pins)
}

/**
 * The ids on the member's phone tab bar, in order (the defaults until they change them). `fetch`
 * false skips asking the server, for the desktop rail, which doesn't show the bar.
 */
export function usePhonePins(fetch = true): readonly string[] {
  return phone.use(fetch)
}

/** Saves the phone tab bar's apps, the way `savePins` saves the rail's. */
export function savePhonePins(pins: readonly string[]): Promise<void> {
  return phone.save(pins)
}

/** Forgets this member's pins, rail and phone (at sign-out, so the next member starts from their own). */
export function forgetPins(): void {
  rail.forget()
  phone.forget()
}
