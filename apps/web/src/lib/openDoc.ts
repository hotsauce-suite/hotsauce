// The open document's "commit pending edits now", for actions elsewhere in the shell that are
// about to move or delete it. Moving first would leave its unsaved edits behind: the next save
// names the old path, which the server then refuses.

import type { CommitOutcome } from '../hooks/useDocument'

let open: { space: string; path: string; commit: () => Promise<CommitOutcome> } | null = null

/** Registers the open doc; returns the unregister function. */
export function registerOpenDoc(
  space: string,
  path: string,
  commit: () => Promise<CommitOutcome>,
): () => void {
  const entry = { space, path, commit }
  open = entry
  return () => {
    if (open === entry) open = null
  }
}

/**
 * Commits the open doc's pending edits if it is `path` or inside the folder `path`. Resolves
 * false when they couldn't be saved (a conflict or an error), so the caller holds off.
 */
export async function saveOpenDocUnder(space: string, path: string): Promise<boolean> {
  if (!open || open.space !== space) return true
  if (open.path !== path && !open.path.startsWith(`${path}/`)) return true
  const outcome = await open.commit()
  return outcome === 'committed' || outcome === 'noop'
}

/** Whether this doc is open in the editor here (it sends its own waiting save). */
export function isOpenDoc(space: string, path: string): boolean {
  return open !== null && open.space === space && open.path === path
}
