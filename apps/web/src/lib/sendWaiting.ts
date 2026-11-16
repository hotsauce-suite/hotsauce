// Sends doc saves that waited on this device for the connection (docs/PLAN-offline.md, A4.4),
// for docs that aren't open: an open doc sends its own (hooks/useDocument). Each goes up with the
// version it was edited from, so the server merges it forward, or keeps it on a conflict branch.
// Only the signed-in member's own: never what another member left on a shared device.

import { api, HotsauceApiError } from '../api/client'
import { markDraft, otherTabOpen, removeDraft, waitingDrafts } from './drafts'
import { inOfflineSession } from './offlineStart'
import { isOpenDoc } from './openDoc'
import { docUrl } from './paths'

export interface SendResult {
  sent: number
  /** Kept on the server's conflict branch: the doc's banner offers Resolve. */
  conflicts: string[]
  /** Refused (the doc was moved, renamed or deleted meanwhile, or access changed): kept on this
   * device as "stranded" for the member to copy (Docs → Kept on this device). */
  failed: Array<{ space: string; path: string; reason: string }>
}

const none = (): SendResult => ({ sent: 0, conflicts: [], failed: [] })

let running: Promise<SendResult> | null = null

/** Sends what `owner` (the signed-in member's user id) left waiting. */
export function sendWaitingDrafts(owner: string): Promise<SendResult> {
  if (inOfflineSession()) return Promise.resolve(none())
  running ??= send(owner).finally(() => {
    running = null
  })
  return running
}

async function send(owner: string): Promise<SendResult> {
  const result = none()
  for (const draft of waitingDrafts(owner)) {
    // The open doc sends its own, even one still opening (its page is the one on screen).
    if (isOpenDoc(draft.space, draft.path) || onScreen(draft.space, draft.path)) continue
    // Another open tab is still typing into it: that tab sends its own.
    if (otherTabOpen(draft.tab)) continue
    const creating = draft.blobOid === 'new'
    try {
      const outcome = await api.putFile(draft.space, {
        path: draft.path,
        content: draft.content,
        ...(creating ? { createOnly: true } : { baseBlobOid: draft.blobOid }),
      })
      // A merge or a conflict branch both leave the text safe on the server.
      removeDraft(draft.key)
      if (outcome.status === 'conflict') result.conflicts.push(draft.path)
      else result.sent += 1
    } catch (err) {
      // Offline again, signed out, or the server is having trouble: they all wait for next time.
      const status = err instanceof HotsauceApiError ? err.status : 0
      if (status === 0 || status === 401 || status >= 500) break
      // Refused for good (moved, renamed or deleted meanwhile; access changed; the name taken):
      // sending again won't help. Kept on this device, and the member is told.
      markDraft(draft.key, 'stranded')
      result.failed.push({ space: draft.space, path: draft.path, reason: reasonFor(status) })
    }
  }
  return result
}

function reasonFor(status: number): string {
  if (status === 404) return 'it was moved, renamed or deleted'
  if (status === 403) return 'you can no longer edit it'
  if (status === 409) return 'a doc with that name already exists'
  return 'the server refused it'
}

function onScreen(space: string, path: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return decodeURIComponent(window.location.pathname) === decodeURIComponent(docUrl(space, path))
  } catch {
    return false
  }
}
