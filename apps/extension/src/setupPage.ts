// The setup page (static/setup.html): opens once on install, and is the extension's options page.
// docs/PLAN-extension-setup.md. What it shows comes from ./setup; this file only reads Chrome.

import { connect, DEFAULT_NAME, getServer, type Server } from './server'
import {
  HELP_URL,
  SHORTCUTS_URL,
  shortcutFor,
  steps,
  TEST_CALL_URL,
  TRIED_KEY,
  updateNote,
} from './setup'

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`setup.html has no #${id}`)
  return found as T
}

async function pinned(): Promise<boolean | null> {
  try {
    return (await chrome.action.getUserSettings()).isOnToolbar
  } catch {
    return null
  }
}

async function tried(): Promise<boolean> {
  return (await chrome.storage.local.get(TRIED_KEY))[TRIED_KEY] === true
}

/** The person pressed Change: the connect form stays open until they connect. */
let changing = false

async function render(): Promise<void> {
  const server = await getServer()
  const name = server?.name ?? DEFAULT_NAME
  for (const node of document.querySelectorAll('.product')) node.textContent = name
  document.title = `Set up ${name}`

  const list = steps({ server, pinned: await pinned(), tried: await tried() }, name)
  for (const step of list) {
    const item = el(`step-${step.id}`)
    item.dataset.done = String(step.done)
    const mark = item.querySelector('.mark')
    if (mark) mark.textContent = step.done ? '✓' : String(list.indexOf(step) + 1)
    const hint = item.querySelector('.hint')
    if (hint) hint.textContent = step.hint
  }
  const done = list.filter((s) => s.done).length
  el('count').textContent = done === list.length ? '· all done' : `· ${done} of ${list.length}`

  showServer(server)

  const commands = await chrome.commands.getAll().catch(() => [])
  const keys = shortcutFor(commands)
  el('shortcut').textContent = keys ?? 'Not set'
  el('how-shortcut').textContent = keys ? ` (or press ${keys})` : ''

  el('version').textContent = chrome.runtime.getManifest().version
  // getSelf needs no permission; guard anyway, in case a Chrome leaves the namespace out.
  const self = await chrome.management?.getSelf().catch(() => null)
  el('updates').textContent = updateNote(self?.installType, server)
}

function showServer(server: Server | null): void {
  const form = el<HTMLFormElement>('server-form')
  const input = el<HTMLInputElement>('server-url')
  form.hidden = server !== null && !changing
  if (server && !input.value) input.value = new URL(server.url).host
  el('workspace').textContent = server ? new URL(server.url).host : 'Not connected'
  el('change-server').hidden = server === null
  const page = el<HTMLAnchorElement>('workspace-page')
  page.hidden = server === null
  if (server) page.href = new URL('/meetings/extension', server.url).toString()
}

function wire(): void {
  const form = el<HTMLFormElement>('server-form')
  const input = el<HTMLInputElement>('server-url')
  const button = el<HTMLButtonElement>('server-connect')
  const error = el('server-error')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    button.disabled = true
    error.hidden = true
    // A click, so Chrome may ask for access to that site.
    void connect(input.value).then((result) => {
      button.disabled = false
      if ('error' in result) {
        error.textContent = result.error
        error.hidden = false
        return
      }
      changing = false
      void render()
    })
  })
  el('change-server').addEventListener('click', () => {
    changing = true
    el('server-form').hidden = false
    el('step-connect').scrollIntoView({ block: 'center' })
    input.focus()
    input.select()
  })
  el('change-shortcut').addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_URL })
  })
  el('test-call').addEventListener('click', () => {
    void chrome.tabs.create({ url: TEST_CALL_URL })
  })
  el<HTMLAnchorElement>('help').href = HELP_URL
  // Pinning happens in Chrome's own menu and the test call in another tab: check again whenever
  // the page comes back, and now and then while it's open.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void render()
  })
  setInterval(() => {
    if (!document.hidden) void render()
  }, 2000)
  chrome.storage.onChanged.addListener(() => void render())
}

wire()
void render()
