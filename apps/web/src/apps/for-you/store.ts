// For you's list, shared by the rail's count, Today's tile, the page and every item page (which
// marks an item seen when it opens). One copy in memory, fetched once and again whenever a comment
// or the member's own marks change, so every place agrees without asking the server each time.

import { COMMENTS_FOLDER, FOR_YOU_STATE_PATH } from '@hotsauce/format'
import { useSyncExternalStore } from 'react'
import { type ForYouMark, type ForYouView, forYouApi } from '../../api/forYou'
import { hotsauceSocket } from '../../api/ws'

export interface ForYouSnapshot {
  status: 'loading' | 'ready' | 'error'
  view: ForYouView
}

const EMPTY: ForYouView = { items: [], unseen: 0, canMark: false }

let snap: ForYouSnapshot = { status: 'loading', view: EMPTY }
let started = false
let turn = 0
let stop: (() => void) | null = null
const listeners = new Set<() => void>()

// An item opened before the list had loaded: checked once it has.
let openedEarly: string | null = null

function set(next: ForYouSnapshot): void {
  snap = next
  for (const l of listeners) l()
  if (openedEarly && next.status === 'ready') {
    const item = openedEarly
    openedEarly = null
    openedForYouItem(item)
  }
}

/** Fetches the list again; an answer older than a later fetch or mark is dropped. */
export function refreshForYou(): Promise<void> {
  const mine = ++turn
  return forYouApi.list().then(
    (view) => {
      if (mine === turn) set({ status: 'ready', view })
    },
    () => {
      // Keep what is on screen; a first load that fails says so.
      if (mine === turn && snap.status === 'loading') set({ ...snap, status: 'error' })
    },
  )
}

function start(): void {
  if (started) return
  started = true
  void refreshForYou()
  const offChanged = hotsauceSocket.onChanged((event) => {
    if (event.paths.some((p) => p.startsWith(`${COMMENTS_FOLDER}/`) || p === FOR_YOU_STATE_PATH)) {
      void refreshForYou()
    }
  })
  const offReconnect = hotsauceSocket.onReconnect(() => void refreshForYou())
  // A Later comes due at 9 AM with nothing changing on the server: look again now and then.
  const timer = setInterval(() => void refreshForYou(), 10 * 60_000)
  stop = () => {
    offChanged()
    offReconnect()
    clearInterval(timer)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => listeners.delete(listener)
}

const read = () => snap

/** The member's For you list, kept current. */
export function useForYou(): ForYouSnapshot {
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Records a mark. The list on screen follows at once for Done and Later (the item leaves), then
 * takes the server's answer.
 */
export async function markForYou(item: string, mark: ForYouMark): Promise<void> {
  const mine = ++turn
  if (mark.action !== 'undone') {
    const items =
      mark.action === 'seen'
        ? snap.view.items.map((i) => (i.item === item ? { ...i, unseen: false } : i))
        : snap.view.items.filter((i) => i.item !== item)
    set({
      ...snap,
      view: { ...snap.view, items, unseen: items.filter((i) => i.unseen).length },
    })
  }
  try {
    const view = await forYouApi.mark(item, mark)
    if (mine === turn) set({ status: 'ready', view })
  } catch (err) {
    if (mine === turn) void refreshForYou()
    throw err
  }
}

/** An item page opened: mark it seen when it is listed and unseen; otherwise nothing is sent. */
export function openedForYouItem(item: string | null | undefined): void {
  if (!item) return
  if (snap.status !== 'ready') {
    openedEarly = item
    start()
    return
  }
  if (!snap.view.canMark) return
  if (!snap.view.items.some((i) => i.item === item && i.unseen)) return
  void markForYou(item, { action: 'seen' }).catch(() => {})
}

/** The browser's time zone, for Later's 9 AM. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Forgets this member's list (at sign-out), and for tests. */
export function forgetForYou(): void {
  stop?.()
  stop = null
  started = false
  turn++
  openedEarly = null
  snap = { status: 'loading', view: EMPTY }
  for (const l of listeners) l()
}
