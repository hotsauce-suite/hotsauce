// The service worker. It marks Meet calls on the toolbar icon, opens Hearth when the person
// clicks "Take notes", and hands the Hearth page a stream id for the Meet tab's audio, which
// spares the person Chrome's "pick a tab, tick share audio" dialog.

import { type Invoked, meetCode, pickTarget, remember } from './meet'
import type { CaptureReply, WorkerMessage } from './protocol'
import { rememberSaveTab, type SaveTab, savable, savePageUrl, takeSaveTab } from './save'
import { DEFAULT_NAME, getServer, isServerPage, originsFor } from './server'

const INVOKED_KEY = 'invoked'
const SAVE_TABS_KEY = 'save-tabs'
/** A save tab that hasn't said it saved by then probably needs a sign-in: it comes forward. */
const SAVE_WAIT_MS = 12_000

async function invokedTabs(): Promise<Invoked[]> {
  const stored = await chrome.storage.session.get(INVOKED_KEY)
  return (stored[INVOKED_KEY] as Invoked[] | undefined) ?? []
}

// --- The toolbar icon: a dot on Meet calls ----------------------------------------------------

async function productName(): Promise<string> {
  return (await getServer())?.name ?? DEFAULT_NAME
}

function markTab(tabId: number, url: string | undefined): void {
  const onCall = meetCode(url) !== null
  void chrome.action.setBadgeText({ tabId, text: onCall ? ' ' : '' })
  void productName().then((name) =>
    chrome.action.setTitle({
      tabId,
      title: onCall ? `Take notes on this call with ${name}` : name,
    }),
  )
}

async function makeMenus(): Promise<void> {
  const name = await productName()
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-page',
      title: `Save page to ${name}`,
      contexts: ['page'],
    })
    chrome.contextMenus.create({
      id: 'save-link',
      title: `Save link to ${name}`,
      contexts: ['link'],
    })
  })
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#c63d19' })
  void makeMenus()
})
// Connecting to another server renames the menus.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.server) void makeMenus()
})

// --- Save to the server -----------------------------------------------------------------------------

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

/** Opens the server's save page for `page` in a background tab beside `from`. */
async function saveToHearth(
  page: { url: string; title?: string },
  from: chrome.tabs.Tab | undefined,
): Promise<void> {
  const server = await getServer()
  // Not connected yet: the popup asks which server first.
  if (!server || !savable(page.url, originsFor(server.url))) return
  const tab = await chrome.tabs.create({
    url: savePageUrl(server.url, page),
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
  const name = await productName()
  await chrome.action.setTitle({ tabId, title: `Saved to ${name}` }).catch(() => {})
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
  const server = await getServer()
  if (!server) return
  const list = remember(await invokedTabs(), { tabId, code, at: Date.now() })
  await chrome.storage.session.set({ [INVOKED_KEY]: list })
  const url = new URL('/meetings/start', server.url)
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
      message: `Click the ${await productName()} icon on the Meet tab, then “Take notes”.`,
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
  // Messages from pages are answered only on the server's own pages.
  if (
    (message.type === 'may-save' ||
      message.type === 'link-saved' ||
      message.type === 'capture-meet') &&
    sender.tab?.id !== undefined
  ) {
    const tabId = sender.tab.id
    void getServer().then(async (server) => {
      if (!isServerPage(server, sender.url)) return sendResponse(undefined)
      // The save page asks before saving on its own: only a tab this worker opened may skip the
      // page's Save button, so another site can't make a signed-in member save something.
      if (message.type === 'may-save') {
        const list = await saveTabs()
        return sendResponse({ ok: list.some((s) => s.saveTabId === tabId) })
      }
      if (message.type === 'link-saved') {
        await linkSaved(tabId, message.ok === true)
        return sendResponse({ ok: true })
      }
      const code = typeof message.code === 'string' ? message.code : null
      sendResponse(await captureMeet(tabId, code))
    })
    return true
  }
  return false
})
