// The toolbar popup. Not connected yet: which server? On a Meet call: "Take notes". On another
// web page: it saves the page straight away. Anywhere else: how to get to the server.

import { meetCode } from './meet'
import type { WorkerMessage } from './protocol'
import { savable } from './save'
import { connect, DEFAULT_NAME, getServer, originsFor, type Server, serverInTab } from './server'
import { TRIED_KEY } from './setup'

function show(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`popup.html has no #${id}`)
  el.hidden = false
  return el
}

function hideAll(): void {
  for (const el of document.querySelectorAll('section')) (el as HTMLElement).hidden = true
}

function setName(name: string): void {
  for (const el of document.querySelectorAll('.product')) el.textContent = name
}

/**
 * The Hotsauce server open in the active tab, if it is one. Opening this popup lets the extension
 * read that tab (`activeTab`), so the tab asks its own `/api/health`.
 */
async function serverInActiveTab(): Promise<Server | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined || !/^https?:/.test(tab.url ?? '')) return null
    const [first] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        fetch('/api/health', { credentials: 'omit' }).then(
          (r) => (r.ok ? r.json() : null),
          () => null,
        ),
    })
    return serverInTab(tab.url, first?.result)
  } catch {
    return null
  }
}

/** Asks which server; the person's click lets Chrome ask for access to that site. */
function askForServer(current: Server | null, found: Server | null = null): void {
  // Don't let a save that finishes now close the popup while the person types.
  stopWatching()
  hideAll()
  setName(current?.name ?? DEFAULT_NAME)
  show('setup')
  const form = document.getElementById('server-form') as HTMLFormElement
  const input = document.getElementById('server-url') as HTMLInputElement
  const error = document.getElementById('server-error') as HTMLElement
  const button = document.getElementById('server-connect') as HTMLButtonElement
  if (current) input.value = current.url
  input.focus()
  if (found && !current) {
    // The person has their server open: one click connects.
    input.value = found.url
    setName(found.name)
    // The address, not the name the page gives itself, is what the person is agreeing to.
    show('setup-title').textContent = `Connect to ${new URL(found.url).host}?`
    show('setup-hint').textContent = `The ${found.name} you have open in this tab.`
    button.focus()
  }
  // Assigned, not added: the form can be shown again by Change server.
  form.onsubmit = (event) => {
    event.preventDefault()
    button.disabled = true
    error.hidden = true
    void connect(input.value).then((result) => {
      button.disabled = false
      if ('error' in result) {
        error.textContent = result.error
        error.hidden = false
        return
      }
      void main()
    })
  }
}

/** Saves the page once per opening of the popup; "Change server" and Connect don't save again. */
let saveStarted = false
let stopWatching: () => void = () => {}

function say(text: string): void {
  ;(document.getElementById('save-status') as HTMLElement).textContent = text
  ;(document.getElementById('save-said') as HTMLElement).textContent = text
}

/**
 * Saves the page in `tabId`, then shows "Saved" once the worker puts the tick on the tab's icon.
 * If the save needs the person (signed out, or it failed), the worker brings the save tab
 * forward, which closes this popup.
 */
async function saveNow(tabId: number, name: string): Promise<void> {
  // A tick left from an earlier save on this tab must not read as this one.
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
  const message: WorkerMessage = { type: 'save-page', tabId }
  const reply = (await chrome.runtime.sendMessage(message).catch(() => null)) as {
    ok?: boolean
  } | null
  if (reply?.ok !== true) {
    say(`Couldn't save this page. Try again, or right-click it and choose Save page.`)
    return
  }
  const started = Date.now()
  const timer = setInterval(() => {
    void chrome.action.getBadgeText({ tabId }).then((text) => {
      if (text === '✓') {
        stopWatching()
        say(`Saved to ${name}`)
        setTimeout(() => window.close(), 1200)
      } else if (Date.now() - started > 15_000) {
        stopWatching()
        say(`Still saving. A ✓ on the icon means it's in ${name}.`)
      }
    })
  }, 250)
  stopWatching = () => clearInterval(timer)
}

async function main(): Promise<void> {
  hideAll()
  const server = await getServer()
  if (!server) {
    askForServer(null, await serverInActiveTab())
    return
  }
  setName(server.name)
  show('change-server')
  // Assigned, not added: main() runs again after Change server → Connect.
  const change = document.getElementById('change-server-button')
  if (change) change.onclick = () => askForServer(server)
  const settings = document.getElementById('open-settings')
  if (settings)
    settings.onclick = () => {
      void chrome.runtime.openOptionsPage().finally(() => window.close())
    }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const code = meetCode(tab?.url)
  if (tab?.id !== undefined && !code && savable(tab.url, originsFor(server.url))) {
    // One click: opening the popup on a page saves it. The popup then says how it went.
    show('save')
    show('page-title').textContent = tab.title || tab.url || ''
    const links = document.getElementById('open-links') as HTMLAnchorElement
    links.href = new URL('/links', server.url).toString()
    if (!saveStarted) {
      saveStarted = true
      void saveNow(tab.id, server.name)
    }
    return
  }
  if (!tab?.id || !code) {
    show('elsewhere')
    const open = document.getElementById('open-hotsauce') as HTMLAnchorElement
    open.href = new URL('/meetings', server.url).toString()
    return
  }
  show('on-call')
  show('code').textContent = code
  // The setup page's "Try it" step: Take notes showed on a call, so the extension works.
  void chrome.storage.local.set({ [TRIED_KEY]: true })
  const button = document.getElementById('take-notes') as HTMLButtonElement
  const tabId = tab.id
  button.addEventListener('click', () => {
    button.disabled = true
    const message: WorkerMessage = { type: 'take-notes', tabId }
    void chrome.runtime.sendMessage(message).finally(() => window.close())
  })
  button.focus()
}

void main()
