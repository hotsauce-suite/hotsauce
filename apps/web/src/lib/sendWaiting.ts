// Sends doc saves that waited on this device for the connection (docs/PLAN-offline.md, A4.4),
// for docs that aren't open: an open doc sends its own (hooks/useDocument). Each goes up with the
// version it was edited from, so the server merges it forward, or keeps it on a conflict branch.

import { api, HearthApiError } from '../api/client'
import { clearDrafts, saveDraft, waitingDrafts } from './drafts'
import { isOpenDoc } from './openDoc'

export interface SendResult {
  sent: number
  /** Kept on the server's conflict branch: the doc's banner offers Resolve. */
  conflicts: string[]
}

let running: Promise<SendResult> | null = null

export function sendWaitingDrafts(): Promise<SendResult> {
  running ??= send().finally(() => {
    running = null
  })
  return running
}

async function send(): Promise<SendResult> {
  const result: SendResult = { sent: 0, conflicts: [] }
  for (const draft of waitingDrafts()) {
    if (isOpenDoc(draft.space, draft.path)) continue
    const creating = draft.blobOid === 'new'
    try {
      const outcome = await api.putFile(draft.space, {
        path: draft.path,
        content: draft.content,
        ...(creating ? { createOnly: true } : { baseBlobOid: draft.blobOid }),
      })
      // A merge or a conflict branch both leave the text safe on the server.
      clearDrafts(draft.space, draft.path)
      if (outcome.status === 'conflict') result.conflicts.push(draft.path)
      else result.sent += 1
    } catch (err) {
      // Offline again, signed out, or the server is having trouble: they all wait for next time.
      const status = err instanceof HearthApiError ? err.status : 0
      if (status === 0 || status === 401 || status >= 500) break
      // Anything else (the doc was deleted, a name taken): trying again won't help. It stays
      // on this device as an ordinary draft, offered when the doc opens.
      saveDraft(draft.space, draft.path, draft.blobOid, draft.content)
    }
  }
  return result
}
