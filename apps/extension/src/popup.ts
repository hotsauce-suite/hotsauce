// The toolbar popup. Not connected yet: which server? On a Meet call: "Take notes". On another
// web page: "Save this page". Anywhere else: how to get to the server.

import { meetCode } from './meet'
import type { WorkerMessage } from './protocol'
import { savable } from './save'
import { connect, DEFAULT_NAME, getServer, originsFor, type Server } from './server'

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

/** Asks which server; the person's click lets Chrome ask for access to that site. */
function askForServer(current: Server | null): void {
  hideAll()
  setName(current?.name ?? DEFAULT_NAME)
  show('setup')
  const form = document.getElementById('server-form') as HTMLFormElement
  const input = document.getElementById('server-url') as HTMLInputElement
  const error = document.getElementById('server-error') as HTMLElement
  const button = document.getElementById('server-connect') as HTMLButtonElement
  if (current) input.value = current.url
  input.focus()
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

async function main(): Promise<void> {
  hideAll()
  const server = await getServer()
  if (!server) {
    askForServer(null)
    return
  }
  setName(server.name)
  show('change-server')
  document
    .getElementById('change-server-button')
    ?.addEventListener('click', () => askForServer(server))
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const code = meetCode(tab?.url)
  if (tab?.id !== undefined && !code && savable(tab.url, originsFor(server.url))) {
    show('save')
    show('page-title').textContent = tab.title || tab.url || ''
    const links = document.getElementById('open-links') as HTMLAnchorElement
    links.href = new URL('/links', server.url).toString()
    const save = document.getElementById('save-page') as HTMLButtonElement
    const tabId = tab.id
    save.addEventListener('click', () => {
      save.disabled = true
      save.textContent = 'Saving…'
      const message: WorkerMessage = { type: 'save-page', tabId }
      void chrome.runtime.sendMessage(message).finally(() => window.close())
    })
    save.focus()
    return
  }
  if (!tab?.id || !code) {
    show('elsewhere')
    const open = document.getElementById('open-hearth') as HTMLAnchorElement
    open.href = new URL('/meetings', server.url).toString()
    return
  }
  show('on-call')
  show('code').textContent = code
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
