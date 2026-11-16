import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

// The one empty screen (docs/PLAN-consistency.md, requirement 5): the app's icon, a headline,
// one sentence on what belongs here or how it arrives, and the app's main button where it has one.

interface EmptyStateProps {
  icon: IconName
  /** "No forms yet", or the list's own line when empty is the goal ("Your inbox is clear"). */
  title: string
  children?: ReactNode
  /** The app's main button, the same one as at the top of the page. */
  action?: ReactNode
  className?: string
  testId?: string
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className = '',
  testId = 'empty-state',
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center gap-3 px-4 py-12 text-center ${className}`}
    >
      <Icon name={icon} className="size-10 text-ink-faint" />
      <p className="font-display text-lg text-ink">{title}</p>
      {children ? <p className="max-w-sm text-sm text-ink-soft">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
