import type { ReactNode } from 'react'
import { Icon } from './Icon'

/** Right-hand panel on desktop, floating over the page on tablets (`.side-pane`); a full-screen sheet on phones. */
export function SidePanel({
  title,
  onClose,
  children,
  testId,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  testId?: string
}) {
  return (
    <aside
      aria-label={title}
      data-testid={testId}
      className="side-pane fixed inset-0 z-30 flex flex-col bg-paper-raised md:static md:z-auto md:w-[var(--panel-width)] md:shrink-0 md:border-l md:border-ash md:bg-paper-raised/60"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-ash/70 px-4">
        <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        <button
          type="button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}
