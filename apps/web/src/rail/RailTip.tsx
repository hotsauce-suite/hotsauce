// The tip beside a rail entry (docs/PLAN-rail-account-menu.md, requirement 3): after a short pause
// on hover or keyboard focus, the entry's name, its shortcut and one line saying what it is for.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Keys } from '../keyboard/KeyCaps'

/** How long the pointer rests before the tip shows: about what the system's own tips wait. */
export const TIP_DELAY_MS = 600

export interface Tip {
  title: string
  /** One line saying what it is. */
  about?: string
  /** Its shortcut, as the shortcuts sheet writes it ("g d"). */
  keys?: string
}

export interface TipHandlers {
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onPointerDown: () => void
  onFocus: (event: React.FocusEvent<HTMLElement>) => void
  onBlur: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  'aria-describedby': string | undefined
}

function keyboardFocus(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

/** `handlers` go on the entry; `node` renders anywhere (it draws itself beside the entry). */
export function useRailTip(tip: Tip): { handlers: TipHandlers; node: ReactNode } {
  const id = useId()
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const wait = (el: HTMLElement) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (!el.isConnected) return
      const rect = el.getBoundingClientRect()
      setAt({ left: rect.right + 10, top: rect.top + rect.height / 2 })
    }, TIP_DELAY_MS)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setAt(null)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // A tip never outlives a scroll or a resize: it would point at nothing.
  useEffect(() => {
    if (!at) return
    const gone = () => setAt(null)
    window.addEventListener('scroll', gone, true)
    window.addEventListener('resize', gone)
    return () => {
      window.removeEventListener('scroll', gone, true)
      window.removeEventListener('resize', gone)
    }
  }, [at])

  const handlers: TipHandlers = {
    // Touch has no hover: a tip there would only sit over what was just tapped.
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse') wait(event.currentTarget)
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (event) => {
      if (keyboardFocus(event.currentTarget)) wait(event.currentTarget)
    },
    onBlur: hide,
    onKeyDown: (event) => {
      // Escape dismisses it; Enter or Space acts on the entry, and the tip is in the way after.
      if (event.key === 'Escape' ? at : event.key === 'Enter' || event.key === ' ') hide()
    },
    'aria-describedby': at ? id : undefined,
  }
  const node = at
    ? createPortal(
        <div
          id={id}
          role="tooltip"
          data-testid="rail-tip"
          style={{ left: at.left, top: at.top }}
          className="rail-tip pointer-events-none fixed z-50 max-w-60 -translate-y-1/2 rounded-lg border border-ash bg-paper-raised px-3 py-2 shadow-float"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            {tip.title}
            {tip.keys ? <Keys spec={tip.keys} className="text-ink-faint" /> : null}
          </p>
          {tip.about ? <p className="mt-0.5 text-xs text-ink-soft">{tip.about}</p> : null}
        </div>,
        document.body,
      )
    : null
  return { handlers, node }
}
