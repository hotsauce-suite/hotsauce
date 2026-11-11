// Unsaved drafts survive reloads in localStorage, keyed `space:path:blobOid` (ARCHITECTURE §4).
// Storage can be unavailable (private mode, quota), so every access is best-effort.

const PREFIX = 'hearth.draft:'

export interface Draft {
  content: string
  /** The version the draft was edited from; committing with it as the base lets the server merge. */
  blobOid: string
  savedAt: number
}

export function draftKey(space: string, path: string, blobOid: string): string {
  return `${PREFIX}${space}:${path}:${blobOid}`
}

export function saveDraft(space: string, path: string, blobOid: string, content: string): void {
  try {
    clearDrafts(space, path)
    localStorage.setItem(
      draftKey(space, path, blobOid),
      JSON.stringify({ content, savedAt: Date.now() }),
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
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        content?: unknown
        savedAt?: unknown
      } | null
      if (typeof parsed?.content !== 'string') continue
      return {
        content: parsed.content,
        blobOid: key.slice(prefix.length),
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      }
    }
  } catch {
    // Corrupt or unavailable storage: no draft.
  }
  return null
}
