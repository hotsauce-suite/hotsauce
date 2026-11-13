// j and k move through a list, as in Gmail and GitHub. A row's main link or button carries
// `data-list-item`; j and k move the focus between them in page order, so Enter opens the row
// with the browser's own behavior and Tab carries on from there. Row keys (p to pin a note)
// act on the row that has focus: `focusedRow` finds it.

import { useShortcut } from './shortcuts'

export const LIST_ITEM = '[data-list-item]'

/** The list items on the page, in order, skipping hidden ones. */
export function listItems(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(LIST_ITEM)].filter(
    (el) => !el.closest('[hidden],[aria-hidden="true"],[inert]'),
  )
}

/** Focuses the next (1) or previous (-1) item; false when the page has no list. */
export function moveInList(step: 1 | -1): boolean {
  const items = listItems()
  if (items.length === 0) return false
  const active = document.activeElement
  const current = active instanceof Element ? active.closest<HTMLElement>(LIST_ITEM) : null
  const at = current ? items.indexOf(current) : -1
  const next =
    at === -1
      ? step === 1
        ? items[0]
        : items[items.length - 1]
      : items[Math.min(items.length - 1, Math.max(0, at + step))]
  next?.focus()
  next?.scrollIntoView?.({ block: 'nearest' })
  return true
}

/** The value of `attribute` on the row holding the focus, if a row holds it. */
export function focusedRow(attribute: string): string | null {
  const active = document.activeElement
  if (!(active instanceof Element)) return null
  return active.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null
}

/** Binds j and k on a page that shows a list. */
export function useListKeys(enabled = true): void {
  useShortcut('list.next', () => moveInList(1), enabled)
  useShortcut('list.previous', () => moveInList(-1), enabled)
}

/**
 * For a row key that takes the row out of the list (archive, mark done): call before acting,
 * and the focus lands on the row that takes its place once the list redraws.
 */
export function holdListPlace(): void {
  const active = document.activeElement
  const current = active instanceof Element ? active.closest<HTMLElement>(LIST_ITEM) : null
  const at = current ? listItems().indexOf(current) : -1
  if (at === -1) return
  requestAnimationFrame(() => {
    if (current?.isConnected && document.activeElement === current) return
    const items = listItems()
    items[Math.min(at, items.length - 1)]?.focus()
  })
}

/** For a row key that moves the row (pin): puts the focus back on it once the list redraws. */
export function followRow(attribute: string, value: string): void {
  const refocus = (tries: number) =>
    requestAnimationFrame(() => {
      const row = document.querySelector(`[${attribute}="${CSS.escape(value)}"]`)
      const item = row?.matches(LIST_ITEM) ? row : row?.querySelector(LIST_ITEM)
      if (item instanceof HTMLElement) {
        if (document.activeElement !== item) item.focus()
      } else if (tries > 0) refocus(tries - 1)
    })
  refocus(10)
}
