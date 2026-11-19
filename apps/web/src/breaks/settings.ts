// The member's screen-break settings in the page (docs/PLAN-breaks.md): loaded from the server
// once, kept in this browser too so breaks start straight away on the next load, and saved back
// on every change. One store for the whole page.

import { type BreakSettings, defaultBreakSettings, readBreakSettings } from '@hotsauce/format'
import { breaksApi } from '../api/breaks'

const CACHE_KEY = 'hotsauce:breaks'

export interface BreaksSettingsState {
  settings: BreakSettings
  /** The member has saved settings (or answered the Getting started offer). */
  saved: boolean
  /** The server's answer has arrived. */
  loaded: boolean
  /** The last save failed. */
  error: string | null
}

let state: BreaksSettingsState = fromCache()
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null
/** Bumped by every save, so an answer to an older load can't undo a newer change. */
let edits = 0

function fromCache(): BreaksSettingsState {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { settings?: unknown; saved?: unknown }
      return {
        settings: readBreakSettings(parsed.settings),
        saved: parsed.saved === true,
        loaded: false,
        error: null,
      }
    }
  } catch {
    // No storage (private window): the server's answer is enough.
  }
  return { settings: defaultBreakSettings(), saved: false, loaded: false, error: null }
}

function set(next: Partial<BreaksSettingsState>) {
  state = { ...state, ...next }
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ settings: state.settings, saved: state.saved }),
    )
  } catch {
    // Nothing to keep it in.
  }
  for (const l of listeners) l()
}

export function breakSettings(): BreaksSettingsState {
  return state
}

export function subscribeBreakSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Fetches the member's settings (once per page unless `force`). */
export function loadBreakSettings(force = false): Promise<void> {
  if (loading && !force) return loading
  const at = edits
  loading = breaksApi
    .get()
    .then((view) =>
      at === edits
        ? set({ settings: view.settings, saved: view.saved, loaded: true })
        : set({ loaded: true }),
    )
    .catch(() => set({ loaded: true }))
  return loading
}

/** Changes some settings and saves them; the page shows the change at once. */
export async function saveBreakSettings(change: Partial<BreakSettings>): Promise<void> {
  const before = state
  edits++
  const settings = { ...state.settings, ...change, schema: 1 as const }
  set({ settings, saved: true, error: null })
  try {
    const view = await breaksApi.save(settings)
    set({ settings: view.settings, saved: true })
  } catch (err) {
    set({
      settings: before.settings,
      saved: before.saved,
      error: err instanceof Error ? err.message : 'Couldn’t save your break settings',
    })
  }
}

/** For tests: forget everything. */
export function resetBreakSettingsForTests(): void {
  state = { settings: defaultBreakSettings(), saved: false, loaded: false, error: null }
  loading = null
  edits = 0
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}

/** "Every 20 min", "Off": what the account menu row says. */
export function breaksStatus(s: BreakSettings): string {
  return s.on ? `Every ${s.everyMinutes} min` : 'Off'
}

/** "20 seconds", "5 minutes", "1 minute 30 seconds". */
export function lengthLabel(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const parts: string[] = []
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  return parts.join(' ') || '0 seconds'
}
