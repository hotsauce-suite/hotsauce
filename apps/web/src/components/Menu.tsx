import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Keys } from '../keyboard/KeyCaps'
import { Icon, type IconName } from './Icon'

export interface MenuAnchor {
  x: number
  y: number
  /** Open upward, the menu's bottom edge at `y` (for buttons at the foot of the screen). */
  above?: boolean
}

/** What the arrow keys move between: items, and the choices of a switch inside the menu. */
const ITEMS = '[role="menuitem"], [role="menuitemradio"]'

/** A floating menu at a point (context menu) or under a button. Closes on outside click or Escape. */
export function Menu({
  anchor,
  onClose,
  children,
  label,
}: {
  anchor: MenuAnchor
  onClose: () => void
  children: ReactNode
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(anchor)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Keep the menu on screen, and again when it grows (a row that opens controls under itself).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const { width, height } = el.getBoundingClientRect()
      const y = anchor.above ? anchor.y - height : anchor.y
      setPosition({
        x: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      })
    }
    place()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => observer.disconnect()
  }, [anchor])

  useEffect(() => {
    // Start on the first thing a member came for, not on an extra like the photo button.
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
    ;(all.find((el) => !el.hasAttribute('data-menu-extra')) ?? all[0])?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Only the menu closes: the pop-up or page it sits in stays open.
        event.stopPropagation()
        event.preventDefault()
        onCloseRef.current()
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Controls of their own inside the menu (a slider, a list of tracks) keep their arrows.
        const active = document.activeElement
        if (
          active instanceof HTMLElement &&
          ref.current?.contains(active) &&
          active !== ref.current &&
          !active.matches(ITEMS)
        ) {
          return
        }
        const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
        const index = items.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1
        items[(next + items.length) % items.length]?.focus()
        event.preventDefault()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    // On the way down, so the menu hears Escape before whatever it sits in.
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 max-h-[calc(100dvh-1rem)] min-w-48 overflow-y-auto rounded-lg border border-ash bg-paper-raised p-1 shadow-float"
    >
      {children}
    </div>,
    document.body,
  )
}

/** How a menu's item looks, for an item that is a link instead of a button. */
const menuItemBase =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-ember-wash focus-visible:bg-ember-wash'
export const menuItemClass = `${menuItemBase} text-ink`

export function MenuItem({
  icon,
  children,
  onSelect,
  testId,
  danger = false,
  keys,
}: {
  icon?: IconName
  children: ReactNode
  onSelect: () => void
  testId?: string
  danger?: boolean
  /** Its shortcut, shown at the row's end ("g s"). */
  keys?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onSelect}
      className={`${menuItemBase} ${danger ? 'text-ember-strong' : 'text-ink'}`}
    >
      {icon ? <Icon name={icon} className="size-4 text-ink-faint" /> : null}
      {keys ? <span className="flex-1">{children}</span> : children}
      {keys ? <Keys spec={keys} className="opacity-80" /> : null}
    </button>
  )
}

/** Anchor point just below an element, for button-triggered menus. */
export function below(element: HTMLElement): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}
