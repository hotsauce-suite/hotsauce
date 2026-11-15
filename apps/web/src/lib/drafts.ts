// Unsaved drafts survive reloads in localStorage, keyed `space:path:blobOid` (ARCHITECTURE §4).
// Storage can be unavailable (private mode, quota), so every access is best-effort.
//
// A draft is "waiting" when its save couldn't reach the server (offline, docs/PLAN-offline.md
// A4): it's sent by itself once the connection is back, instead of being offered for restore.

const PREFIX = 'hearth.draft:'

export interface Draft {
  content: string
  /** The version the draft was edited from; committing with it as the base lets the server merge. */
  blobOid: string
  savedAt: number
  /** Its save couldn't reach the server; it goes up by itself when the connection is back. */
  waiting: boolean
}

export interface WaitingDraft extends Draft {
  space: string
  path: string
}

export function draftKey(space: string, path: string, blobOid: string): string {
  return `${PREFIX}${space}:${path}:${blobOid}`
}

export function saveDraft(
  space: string,
  path: string,
  blobOid: string,
  content: string,
  opts: { waiting?: boolean } = {},
): void {
  try {
    clearDrafts(space, path)
    localStorage.setItem(
      draftKey(space, path, blobOid),
      JSON.stringify({ content, savedAt: Date.now(), ...(opts.waiting ? { waiting: true } : {}) }),
    )
  } catch {
    // Best-effort.
  }
}

function draftKeys(space: string, path: string): string[] {
  const prefix = `${PREFIX}${space}:${path}:`
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix) && !key.slice(prefix.length).includes('/')) keys.push(key)
  }
  return keys
}

export function clearDrafts(space: string, path: string): void {
  try {
    for (const key of draftKeys(space, path)) localStorage.removeItem(key)
  } catch {
    // Best-effort.
  }
}

/** The draft for this file, whatever version it was based on. */
export function findDraft(space: string, path: string): Draft | null {
  try {
    const prefix = `${PREFIX}${space}:${path}:`
    for (const key of draftKeys(space, path)) {
      const draft = parseDraft(localStorage.getItem(key), key.slice(prefix.length))
      if (draft) return draft
    }
  } catch {
    // Corrupt or unavailable storage: no draft.
  }
  return null
}

function parseDraft(raw: string | null, blobOid: string): Draft | null {
  const parsed = JSON.parse(raw ?? 'null') as {
    content?: unknown
    savedAt?: unknown
    waiting?: unknown
  } | null
  if (typeof parsed?.content !== 'string') return null
  return {
    content: parsed.content,
    blobOid,
    savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    waiting: parsed.waiting === true,
  }
}

/** Every draft on this device whose save is waiting for the connection, newest first. */
export function waitingDrafts(): WaitingDraft[] {
  const found: WaitingDraft[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      // space:path:blobOid; a space name has no colon, a blob id has none either.
      const rest = key.slice(PREFIX.length)
      const first = rest.indexOf(':')
      const last = rest.lastIndexOf(':')
      if (first <= 0 || last <= first) continue
      const draft = parseDraft(localStorage.getItem(key), rest.slice(last + 1))
      if (!draft?.waiting) continue
      found.push({ ...draft, space: rest.slice(0, first), path: rest.slice(first + 1, last) })
    }
  } catch {
    // Corrupt or unavailable storage: nothing waiting.
  }
  return found.sort((a, b) => b.savedAt - a.savedAt)
}
