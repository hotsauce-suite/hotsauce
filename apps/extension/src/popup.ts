// The toolbar popup. On a Meet call: "Take notes". Anywhere else: how to get to one.

import { HEARTH_URL } from './config'
import { meetCode } from './meet'
import type { WorkerMessage } from './protocol'

function show(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`popup.html has no #${id}`)
  el.hidden = false
  return el
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const code = meetCode(tab?.url)
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
