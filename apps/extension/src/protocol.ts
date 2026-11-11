// Messages between the Hearth page, the bridge content script, and the service worker.
// apps/web/src/apps/meetings/extension.ts speaks the page side of this; keep the two in step.

/** Page → bridge, through window.postMessage. */
export const PAGE_SOURCE = 'hearth-page'
/** Bridge → page. */
export const EXTENSION_SOURCE = 'hearth-extension'

export type PageMessage =
  | { source: typeof PAGE_SOURCE; type: 'hello'; id: string }
  /** `code`: the call the page is for, when it knows it ("abc-defg-hij"). */
  | { source: typeof PAGE_SOURCE; type: 'capture-meet'; id: string; code?: string }

export type CaptureFailure =
  /**
   * No Meet tab the person clicked the Hearth icon on is still on the page's call (or, when the
   * page didn't say which call, on any call they clicked it on in the last ten minutes).
   */
  | 'not-invoked'
  /** Chrome refused: the tab is already being captured, or the grant lapsed. */
  | 'failed'

export type CaptureReply =
  | { ok: true; streamId: string; code: string }
  | { ok: false; reason: CaptureFailure; message: string }

/** Popup or bridge → service worker, through chrome.runtime.sendMessage. */
export type WorkerMessage =
  | { type: 'take-notes'; tabId: number }
  | { type: 'capture-meet'; code?: string }

export function isPageMessage(data: unknown): data is PageMessage {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  if (d.source !== PAGE_SOURCE || typeof d.id !== 'string') return false
  if (d.type === 'hello') return true
  return d.type === 'capture-meet' && (d.code === undefined || typeof d.code === 'string')
}
