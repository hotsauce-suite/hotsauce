import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../../components/Icon'

/** One tile's frame on Today: an icon, a title, and an optional link on the right. */
export function Card({
  title,
  icon,
  testId,
  action,
  children,
}: {
  title: string
  icon: IconName
  testId: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="rounded-2xl border border-ash bg-paper-raised/60 px-4 py-4 md:px-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} className="size-4 text-ink-faint" />
        <h2 className="flex-1 text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-faint">{children}</p>
}
