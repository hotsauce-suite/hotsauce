// Content script on Hearth's own pages: relays the page's window messages to the service worker
// and back. The page can't call chrome.runtime itself without knowing this extension's id.

import { type CaptureReply, EXTENSION_SOURCE, isPageMessage, type WorkerMessage } from './protocol'

const version = chrome.runtime.getManifest().version

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: EXTENSION_SOURCE, ...message }, window.location.origin)
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return
  const data: unknown = event.data
  if (!isPageMessage(data)) return
  if (data.type === 'hello') {
    post({ type: 'hello', id: data.id, version })
    return
  }
  if (data.type === 'may-save') {
    const ask: WorkerMessage = { type: 'may-save' }
    chrome.runtime.sendMessage(ask).then(
      (reply: { ok?: boolean } | undefined) =>
        post({ type: 'may-save', id: data.id, ok: reply?.ok === true }),
      () => post({ type: 'may-save', id: data.id, ok: false }),
    )
    return
  }
  if (data.type === 'link-saved') {
    const done: WorkerMessage = { type: 'link-saved', ok: data.ok }
    chrome.runtime.sendMessage(done).catch(() => {})
    return
  }
  const ask: WorkerMessage = {
    type: 'capture-meet',
    ...(data.code === undefined ? {} : { code: data.code }),
  }
  chrome.runtime.sendMessage(ask).then(
    (reply: CaptureReply | undefined) =>
      post({
        type: 'capture-meet',
        id: data.id,
        ...(reply ?? { ok: false, reason: 'failed', message: 'No answer from the extension.' }),
      }),
    (err: unknown) =>
      post({
        type: 'capture-meet',
        id: data.id,
        ok: false,
        reason: 'failed',
        message: err instanceof Error ? err.message : String(err),
      }),
  )
})
