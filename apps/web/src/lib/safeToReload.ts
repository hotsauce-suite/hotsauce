// Whether reloading the page now would lose anything (docs/PLAN-reload-after-updates.md, R4).

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

/** A text box holding text, outside the doc editor (whose drafts are kept on the device). */
export function holdsTyping(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    if (el.disabled || el.readOnly) continue
    if (el instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(el.type.toLowerCase())) continue
    if (el.value.trim() !== '') return true
  }
  for (const el of doc.querySelectorAll<HTMLElement>('[contenteditable]')) {
    if (!el.isContentEditable || el.closest('.cm-editor')) continue
    if ((el.textContent ?? '').trim() !== '') return true
  }
  return false
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
}): 'meeting' | 'guarded' | 'typing' | 'dialog' | null {
  // First: a meeting's own leave handler also flushes its notes, so don't ask it needlessly.
  if (opts.recordingMeeting) return 'meeting'
  if (guardsLeaving(opts.win)) return 'guarded'
  if (holdsTyping(opts.doc)) return 'typing'
  if (dialogOpen(opts.doc)) return 'dialog'
  return null
}
