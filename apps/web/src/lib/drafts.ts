// Unsaved drafts survive reloads in localStorage (ARCHITECTURE §4, docs/PLAN-offline.md A4).
//
// Each draft belongs to one member and one tab: `hotsauce.draft:<owner>/<tab>/<space>/<path>/
// <blobOid>`, every part URI-encoded. So on a shared computer one member never sees, sends or
// erases another's text, and two tabs on the same doc never erase each other's. Drafts saved
// before this (`hearth.draft:<space>:<path>:<blobOid>`, no owner) are still read, offered for
// restore as before, and replaced once restored.
//
// A draft is `editing` (offered for restore if the page went away), `waiting` (its save couldn't
// reach the server; sent by itself when the connection is back, only as its owner) or `stranded`
// (sent, but refused: the doc was moved, renamed or deleted meanwhile; listed under "Kept on this
// device" until the member copies or discards it). Storage can be unavailable or full, so writes
// say whether they worked and every read is best-effort.

const PREFIX = 'hotsauce.draft:'
const LEGACY_PREFIX = 'hearth.draft:'

export type DraftState = 'editing' | 'waiting' | 'stranded'

export interface Draft {
  content: string
  /** The version the draft was edited from; committing with it as the base lets the server merge. */
  blobOid: string
  savedAt: number
  state: DraftState
  /** Who typed it (their user id); null for a draft saved before drafts had owners. */
  owner: string | null
  /** Where it's stored, so it can be replaced or removed exactly. */
  key: string
  /** The tab that typed it; null for a draft saved before drafts had tabs. */
  tab: string | null
}

export interface StoredDraft extends Draft {
  space: string
  path: string
}

let fallbackTab: string | null = null

/** This tab's id: kept for the tab's life (reloads too), different in every other tab. */
export function tabId(): string {
  try {
    const kept = sessionStorage.getItem('hotsauce.tab')
    if (kept) return kept
    const made = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem('hotsauce.tab', made)
    return made
  } catch {
    fallbackTab ??= Math.random().toString(36).slice(2, 10)
    return fallbackTab
  }
}

const enc = encodeURIComponent

export function draftKey(owner: string, space: string, path: string, blobOid: string): string {
  return `${PREFIX}${[owner, tabId(), space, path, blobOid].map(enc).join('/')}`
}

interface KeyParts {
  owner: string | null
  tab: string | null
  space: string
  path: string
  blobOid: string
}

function parseKey(key: string): KeyParts | null {
  if (key.startsWith(PREFIX)) {
    const parts = key.slice(PREFIX.length).split('/')
    if (parts.length !== 5) return null
    try {
      const [owner = '', tab = '', space = '', path = '', blobOid = ''] =
        parts.map(decodeURIComponent)
      // An empty owner: typed before the app knew who was signed in; treated like an old draft.
      return { owner: owner || null, tab, space, path, blobOid }
    } catch {
      return null
    }
  }
  if (key.startsWith(LEGACY_PREFIX)) {
    // space:path:blobOid; a space name has no colon, nor does a blob id.
    const rest = key.slice(LEGACY_PREFIX.length)
    const first = rest.indexOf(':')
    const last = rest.lastIndexOf(':')
    if (first <= 0 || last <= first || rest.slice(last + 1).includes('/')) return null
    return {
      owner: null,
      tab: null,
      space: rest.slice(0, first),
      path: rest.slice(first + 1, last),
      blobOid: rest.slice(last + 1),
    }
  }
  return null
}

function parseBody(
  raw: string | null,
): { content: string; savedAt: number; state: DraftState } | null {
  try {
    const parsed = JSON.parse(raw ?? 'null') as {
      content?: unknown
      savedAt?: unknown
      state?: unknown
    } | null
    if (typeof parsed?.content !== 'string') return null
    const state =
      parsed.state === 'waiting' || parsed.state === 'stranded' ? parsed.state : 'editing'
    return {
      content: parsed.content,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      state,
    }
  } catch {
    return null
  }
}

/** Every stored draft, old and new, newest first. */
function allDrafts(): StoredDraft[] {
  const found: StoredDraft[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      const where = key ? parseKey(key) : null
      if (!key || !where) continue
      const body = parseBody(localStorage.getItem(key))
      if (body) found.push({ ...where, ...body, key })
    }
  } catch {
    // Unavailable storage: no drafts.
  }
  return found.sort((a, b) => b.savedAt - a.savedAt)
}

function forDoc(space: string, path: string) {
  return allDrafts().filter((d) => d.space === space && d.path === path)
}

/**
 * Keeps `content` as `owner`'s draft of this doc from this tab. The new copy is written first and
 * this tab's older copies removed only after: a full or blocked storage leaves the last good copy
 * in place, and the answer is false so the caller doesn't claim it's on the device.
 */
export function saveDraft(
  owner: string,
  space: string,
  path: string,
  blobOid: string,
  content: string,
  state: DraftState = 'editing',
): boolean {
  const key = draftKey(owner, space, path, blobOid)
  try {
    localStorage.setItem(key, JSON.stringify({ content, savedAt: Date.now(), state }))
  } catch {
    return false
  }
  const tab = tabId()
  for (const draft of forDoc(space, path)) {
    if (
      draft.key !== key &&
      draft.owner === owner &&
      draft.tab === tab &&
      draft.state !== 'stranded'
    )
      removeDraft(draft.key)
  }
  return true
}

export function removeDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Best-effort.
  }
}

/** Changes a stored draft's state in place (a waiting save refused by the server is stranded). */
export function markDraft(key: string, state: DraftState): void {
  try {
    const body = parseBody(localStorage.getItem(key))
    if (body) localStorage.setItem(key, JSON.stringify({ ...body, state }))
  } catch {
    // Best-effort: it stays as it was.
  }
}

/**
 * Removes `owner`'s drafts of this doc from this tab (its save went through). Never a stranded
 * one: that goes only when the member discards it from "Kept on this device".
 */
export function clearDrafts(owner: string, space: string, path: string): void {
  const tab = tabId()
  for (const draft of forDoc(space, path)) {
    if (draft.owner === owner && draft.tab === tab && draft.state !== 'stranded')
      removeDraft(draft.key)
  }
}

/**
 * The draft of this doc to show `owner`: their newest, from any tab, else one saved before drafts
 * had owners. Never another member's.
 */
export function findDraft(space: string, path: string, owner: string | null): Draft | null {
  const drafts = forDoc(space, path)
  const mine = owner ? drafts.find((d) => d.owner === owner) : undefined
  const found = mine ?? drafts.find((d) => d.owner === null)
  if (!found) return null
  const { space: _space, path: _path, ...draft } = found
  return draft
}

/** `owner`'s drafts waiting for the connection, newest first. */
export function waitingDrafts(owner: string | null): StoredDraft[] {
  if (!owner) return []
  return allDrafts().filter((d) => d.owner === owner && d.state === 'waiting')
}

/** `owner`'s drafts the server refused (the doc moved or went), newest first. */
export function strandedDrafts(owner: string | null): StoredDraft[] {
  if (!owner) return []
  return allDrafts().filter((d) => d.owner === owner && d.state === 'stranded')
}

// Open tabs say they're alive every few seconds, so a tab never sends or takes over a waiting
// save that another open tab is still typing into (that tab sends its own).
const ALIVE_PREFIX = 'hotsauce.tab-alive:'
const BEAT_MS = 5_000
const ALIVE_FOR_MS = 3 * BEAT_MS

/** Starts this tab's heartbeat; returns a stop function. */
export function keepTabAlive(): () => void {
  const key = ALIVE_PREFIX + tabId()
  const beat = () => {
    try {
      localStorage.setItem(key, String(Date.now()))
    } catch {
      // Best-effort: without it other tabs treat this one as gone, as before.
    }
  }
  const gone = () => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Best-effort.
    }
  }
  beat()
  const timer = setInterval(beat, BEAT_MS)
  window.addEventListener('pagehide', gone)
  return () => {
    clearInterval(timer)
    window.removeEventListener('pagehide', gone)
    gone()
  }
}

/** Whether `tab` is another tab that's open right now. */
export function otherTabOpen(tab: string | null): boolean {
  if (!tab || tab === tabId()) return false
  try {
    const at = Number(localStorage.getItem(ALIVE_PREFIX + tab))
    return Number.isFinite(at) && Date.now() - at < ALIVE_FOR_MS
  } catch {
    return false
  }
}
