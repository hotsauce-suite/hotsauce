// Whether reloading the page now would lose anything (docs/PLAN-reload-after-updates.md, R4).

import { leaveGuarded } from './leaveGuards'

/** Field types a person types text into. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number'])

/**
 * Something the page guards on the way out: every editor and recorder in Hotsauce calls
 * `preventDefault()` on `beforeunload` while leaving would lose something (unsaved typing, a
 * recording). Asking them the same way covers every one, including ones added later.
 */
export function guardsLeaving(win: Window = window): boolean {
  const probe = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(probe)
  return probe.defaultPrevented
}

/** Fields someone typed into since the page loaded (watchTyping). */
const typed = new WeakSet<EventTarget>()
const watched = new WeakSet<Document>()

/** Starts noting which fields get typed into, so saved values shown in a form don't count. */
export function watchTyping(doc: Document = document): void {
  if (watched.has(doc)) return
  watched.add(doc)
  doc.addEventListener('input', (event) => event.target && typed.add(event.target), true)
}

/** A text box holding text someone typed, outside the doc editor (its drafts are kept). */
export function holdsTyping(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    if (!typed.has(el) || el.disabled || el.readOnly) continue
    if (el instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(el.type.toLowerCase())) continue
    if (el.closest('.cm-editor')) continue
    if (el.value.trim() !== '') return true
  }
  for (const el of doc.querySelectorAll<HTMLElement>('[contenteditable]')) {
    if (!typed.has(el) || !el.isContentEditable || el.closest('.cm-editor')) continue
    if ((el.textContent ?? '').trim() !== '') return true
  }
  return false
}

/** Audio or video playing (not a live camera preview), full screen, or picture in picture. */
export function watching(doc: Document = document): boolean {
  for (const media of doc.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (media.srcObject) continue
    if (!media.paused && !media.ended) return true
  }
  const pip = doc as Document & { pictureInPictureElement?: Element | null }
  return Boolean(doc.fullscreenElement || pip.pictureInPictureElement)
}

/** An open dialog: someone is in the middle of something. */
export function dialogOpen(doc: Document = document): boolean {
  return doc.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null
}

/** Why the page can't reload now, or null when it can. */
export function reloadBlocker(opts: {
  recordingMeeting: boolean
  win?: Window
  doc?: Document
}): 'meeting' | 'busy' | 'typing' | 'dialog' | 'watching' | 'guarded' | null {
  if (opts.recordingMeeting) return 'meeting'
  if (leaveGuarded()) return 'busy'
  if (holdsTyping(opts.doc)) return 'typing'
  if (dialogOpen(opts.doc)) return 'dialog'
  if (watching(opts.doc)) return 'watching'
  // Last: the page's own leave handlers, asked the way the browser asks them. Some have side
  // effects (a dirty doc writes its draft; a board closes an open text edit), so only once
  // nothing cheaper has already said no.
  if (guardsLeaving(opts.win)) return 'guarded'
  return null
}
