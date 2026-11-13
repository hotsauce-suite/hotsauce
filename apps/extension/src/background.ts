// The service worker. It marks Meet calls on the toolbar icon, opens Hearth when the person
// clicks "Take notes", and hands the Hearth page a stream id for the Meet tab's audio, which
// spares the person Chrome's "pick a tab, tick share audio" dialog.

import { HEARTH_ORIGINS, HEARTH_URL, isHearthPage, PRODUCT_NAME } from './config'
import { type Invoked, meetCode, pickTarget, remember } from './meet'
import type { CaptureReply, WorkerMessage } from './protocol'
import { rememberSaveTab, type SaveTab, savable, savePageUrl, takeSaveTab } from './save'

const INVOKED_KEY = 'invoked'
const SAVE_TABS_KEY = 'save-tabs'
/** A save tab that hasn't said it saved by then probably needs a sign-in: it comes forward. */
const SAVE_WAIT_MS = 12_000

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
    title: onCall ? `Take notes on this call with ${PRODUCT_NAME}` : PRODUCT_NAME,
  })
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#c63d19' })
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-page',
      title: `Save page to ${PRODUCT_NAME}`,
      contexts: ['page'],
    })
    chrome.contextMenus.create({
      id: 'save-link',
      title: `Save link to ${PRODUCT_NAME}`,
      contexts: ['link'],
    })
  })
})

// --- Save to Hearth -----------------------------------------------------------------------------

async function saveTabs(): Promise<SaveTab[]> {
  await saveTabsChain
  const stored = await chrome.storage.session.get(SAVE_TABS_KEY)
  return (stored[SAVE_TABS_KEY] as SaveTab[] | undefined) ?? []
}

// Changes to the list run one after another, so two quick saves can't drop each other's tab.
let saveTabsChain: Promise<unknown> = Promise.resolve()
function changeSaveTabs<T>(
  change: (list: SaveTab[]) => { list: SaveTab[]; result: T },
): Promise<T> {
  const run = saveTabsChain.then(async () => {
    const stored = await chrome.storage.session.get(SAVE_TABS_KEY)
    const { list, result } = change((stored[SAVE_TABS_KEY] as SaveTab[] | undefined) ?? [])
    await chrome.storage.session.set({ [SAVE_TABS_KEY]: list })
    return result
  })
  saveTabsChain = run.catch(() => {})
  return run
}

/** Opens Hearth's save page for `page` in a background tab beside `from`. */
async function saveToHearth(
  page: { url: string; title?: string },
  from: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (!savable(page.url, HEARTH_ORIGINS)) return
  const tab = await chrome.tabs.create({
    url: savePageUrl(HEARTH_URL, page),
    active: false,
    ...(from?.windowId !== undefined ? { windowId: from.windowId } : {}),
    ...(from?.index !== undefined ? { index: from.index + 1 } : {}),
  })
  if (tab.id === undefined) return
  const saveTabId = tab.id
  await changeSaveTabs((list) => ({
    list: rememberSaveTab(list, { saveTabId, fromTabId: from?.id ?? null, at: Date.now() }),
    result: null,
  }))
  // Signed out, or slow: show the tab so the person can sign in or see what went wrong.
  setTimeout(() => {
    void saveTabs().then((now) => {
      if (now.some((s) => s.saveTabId === saveTabId)) {
        void chrome.tabs.update(saveTabId, { active: true }).catch(() => {})
      }
    })
  }, SAVE_WAIT_MS)
}

/** The save page said how it went: on success its tab closes and the icon shows a tick. */
async function linkSaved(saveTabId: number, ok: boolean): Promise<void> {
  const entry = await changeSaveTabs((list) => {
    const { entry, rest } = takeSaveTab(list, saveTabId)
    return { list: rest, result: entry }
  })
  if (!entry) return
  if (!ok) {
    await chrome.tabs.update(saveTabId, { active: true }).catch(() => {})
    return
  }
  await chrome.tabs.remove(saveTabId).catch(() => {})
  const tabId = entry.fromTabId
  if (tabId === null) return
  await chrome.action.setBadgeText({ tabId, text: '✓' }).catch(() => {})
  await chrome.action.setTitle({ tabId, title: `Saved to ${PRODUCT_NAME}` }).catch(() => {})
  setTimeout(() => {
    void chrome.tabs.get(tabId).then(
      (tab) => markTab(tabId, tab.url),
      () => {},
    )
  }, 2500)
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-link' && info.linkUrl) {
    void saveToHearth(
      { url: info.linkUrl, ...(info.selectionText ? { title: info.selectionText } : {}) },
      tab,
    )
  } else if (info.menuItemId === 'save-page' && tab?.url) {
    void saveToHearth({ url: tab.url, ...(tab.title ? { title: tab.title } : {}) }, tab)
  }
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
      message: `Click the ${PRODUCT_NAME} icon on the Meet tab, then “Take notes”.`,
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
  if (message.type === 'save-page' && sender.id === chrome.runtime.id && !sender.tab) {
    chrome.tabs.get(message.tabId).then(
      (tab) =>
        saveToHearth({ url: tab.url ?? '', ...(tab.title ? { title: tab.title } : {}) }, tab).then(
          () => sendResponse({ ok: true }),
        ),
      () => sendResponse({ ok: false }),
    )
    return true
  }
  // The save page asks before saving on its own: only a tab this worker opened may skip the
  // page's Save button, so another site can't make a signed-in member save something.
  if (message.type === 'may-save' && sender.tab?.id !== undefined && isHearthPage(sender.url)) {
    const tabId = sender.tab.id
    void saveTabs().then((list) => sendResponse({ ok: list.some((s) => s.saveTabId === tabId) }))
    return true
  }
  if (message.type === 'link-saved' && sender.tab?.id !== undefined && isHearthPage(sender.url)) {
    void linkSaved(sender.tab.id, message.ok === true).then(() => sendResponse({ ok: true }))
    return true
  }
  if (message.type === 'capture-meet' && sender.tab?.id !== undefined && isHearthPage(sender.url)) {
    const code = typeof message.code === 'string' ? message.code : null
    void captureMeet(sender.tab.id, code).then(sendResponse)
    return true
  }
  return false
})
