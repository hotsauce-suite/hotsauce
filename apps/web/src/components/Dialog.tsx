import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  testId?: string
  wide?: boolean
  /** False where there is nothing to close to: the pop-up ends only by its own buttons. */
  closable?: boolean
  /** Beside the × at the top right: a thing's ⋯ More (a file's Rename and Delete). */
  actions?: ReactNode
}

/** A modal with a title; Escape and the backdrop close it. */
export function Dialog({
  title,
  onClose,
  children,
  testId,
  wide = false,
  closable = true,
  actions,
}: DialogProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    // Not the buttons at the top right (×, a file's ⋯ More): focus starts on what the pop-up is for.
    const first = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        'input, textarea, button:not([data-dialog-close]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].find((el) => !el.closest('[data-dialog-actions]'))
    // Nothing to focus (a sheet of text): focus the panel, so keys and Tab stay inside it.
    ;(first ?? panel.current)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Only the top pop-up closes (a Rename opened from a file's pop-up), not the one under it.
      const open = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (open[open.length - 1] !== panel.current) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        data-dialog-close
        className="fixed inset-0 cursor-default bg-paper-sunk/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        data-testid={testId}
        className={`relative w-full rounded-xl border border-ash bg-paper-raised p-5 shadow-float outline-none ${wide ? 'max-w-5xl' : 'max-w-md'}`}
      >
        <div className="mb-4 flex items-start gap-3">
          <h2
            id={titleId}
            className="min-w-0 flex-1 font-display text-xl font-semibold break-words text-ink"
          >
            {title}
          </h2>
          {actions ? (
            <div data-dialog-actions className="-mt-1 flex items-center">
              {actions}
            </div>
          ) : null}
          {/* Every pop-up closes from its top right (docs/PLAN-consistency.md, requirement 9). */}
          {closable ? (
            <button
              type="button"
              aria-label="Close"
              title="Close"
              data-dialog-close
              data-testid="dialog-x"
              onClick={onClose}
              className="-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
