// The toolbar popup. On a Meet call: "Take notes". On another web page: "Save this page".
// Anywhere else: how to get to Hearth.

import { HEARTH_ORIGINS, HEARTH_URL, PRODUCT_NAME } from './config'
import { meetCode } from './meet'
import type { WorkerMessage } from './protocol'
import { savable } from './save'

function show(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`popup.html has no #${id}`)
  el.hidden = false
  return el
}

async function main(): Promise<void> {
  for (const el of document.querySelectorAll('.product')) el.textContent = PRODUCT_NAME
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const code = meetCode(tab?.url)
  if (tab?.id !== undefined && !code && savable(tab.url, HEARTH_ORIGINS)) {
    show('save')
    show('page-title').textContent = tab.title || tab.url || ''
    const links = document.getElementById('open-links') as HTMLAnchorElement
    links.href = new URL('/links', HEARTH_URL).toString()
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
    open.href = new URL('/meetings', HEARTH_URL).toString()
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
