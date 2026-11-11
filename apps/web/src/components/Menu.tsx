import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface MenuAnchor {
  x: number
  y: number
  /** Open upward, the menu's bottom edge at `y` (for buttons at the foot of the screen). */
  above?: boolean
}

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

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const y = anchor.above ? anchor.y - height : anchor.y
    setPosition({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
  }, [anchor])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1
        items[(next + items.length) % items.length]?.focus()
        event.preventDefault()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-48 rounded-lg border border-ash bg-paper-raised p-1 shadow-float"
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  icon,
  children,
  onSelect,
  testId,
  danger = false,
}: {
  icon?: IconName
  children: ReactNode
  onSelect: () => void
  testId?: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-ember-wash focus-visible:bg-ember-wash ${danger ? 'text-ember-strong' : 'text-ink'}`}
    >
      {icon ? <Icon name={icon} className="size-4 text-ink-faint" /> : null}
      {children}
    </button>
  )
}

/** Anchor point just below an element, for button-triggered menus. */
export function below(element: HTMLElement): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}
