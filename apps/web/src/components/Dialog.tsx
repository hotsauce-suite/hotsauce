import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  testId?: string
  wide?: boolean
}

/** A modal with a title; Escape and the backdrop close it. */
export function Dialog({ title, onClose, children, testId, wide = false }: DialogProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>(
      'input, textarea, button:not([data-dialog-close]), [href], [tabindex]:not([tabindex="-1"])',
    )
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
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
        aria-label="Close"
        tabIndex={-1}
        data-dialog-close
        className="fixed inset-0 cursor-default bg-paper-sunk/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`relative w-full rounded-xl border border-ash bg-paper-raised p-5 shadow-float ${wide ? 'max-w-5xl' : 'max-w-md'}`}
      >
        <h2 id={titleId} className="mb-4 font-display text-xl font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
