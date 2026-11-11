// The service worker. It marks Meet calls on the toolbar icon, opens Hearth when the person
// clicks "Take notes", and hands the Hearth page a stream id for the Meet tab's audio, which
// spares the person Chrome's "pick a tab, tick share audio" dialog.

import { HEARTH_URL, isHearthPage } from './config'
import { type Invoked, meetCode, pickTarget, remember } from './meet'
import type { CaptureReply, WorkerMessage } from './protocol'

const INVOKED_KEY = 'invoked'

async function invokedTabs(): Promise<Invoked[]> {
  const stored = await chrome.storage.session.get(INVOKED_KEY)
  return (stored[INVOKED_KEY] as Invoked[] | undefined) ?? []
}

// --- The toolbar icon: a dot on Meet calls ----------------------------------------------------

function markTab(tabId: number, url: string | undefined): void {
  const onCall = meetCode(url) !== null
  void chrome.action.setBadgeText({ tabId, text: onCall ? ' ' : '' })
  void chrome.action.setTitle({
    tabId,
    title: onCall ? 'Take notes on this call with Hearth' : 'Hearth Meetings',
  })
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#c63d19' })
})
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url !== undefined || info.status === 'complete') markTab(tabId, tab.url)
})

// --- Messages ---------------------------------------------------------------------------------

async function takeNotes(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId)
  const code = meetCode(tab.url)
  if (!code) return
  const list = remember(await invokedTabs(), { tabId, code, at: Date.now() })
  await chrome.storage.session.set({ [INVOKED_KEY]: list })
  const url = new URL('/meetings/start', HEARTH_URL)
  url.searchParams.set('via', 'extension')
  url.searchParams.set('meet', code)
  await chrome.tabs.create({
    url: url.toString(),
    ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    index: tab.index + 1,
  })
}

async function captureMeet(consumerTabId: number, code: string | null): Promise<CaptureReply> {
  const target = await pickTarget(await invokedTabs(), { code, now: Date.now() }, (id) =>
    chrome.tabs.get(id).then(
      (tab) => tab.url,
      () => undefined,
    ),
  )
  if (!target) {
    return {
      ok: false,
      reason: 'not-invoked',
      message: 'Click the Hearth icon on the Meet tab, then “Take notes”.',
    }
  }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: target.tabId,
      consumerTabId,
    })
    return { ok: true, streamId, code: target.code }
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

chrome.runtime.onMessage.addListener((message: WorkerMessage, sender, sendResponse) => {
  // Only this extension's popup (no tab) may open notes; only a Hearth page may ask for audio.
  if (message.type === 'take-notes' && sender.id === chrome.runtime.id && !sender.tab) {
    takeNotes(message.tabId).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    )
    return true
  }
  if (message.type === 'capture-meet' && sender.tab?.id !== undefined && isHearthPage(sender.url)) {
    const code = typeof message.code === 'string' ? message.code : null
    void captureMeet(sender.tab.id, code).then(sendResponse)
    return true
  }
  return false
})
