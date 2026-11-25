import type { ReactNode } from 'react'

/**
 * The Sign pages' layout: the document fills the page, and the controls (people, field types,
 * the signing panel) sit in a rail on the right that stays in view while the pages scroll. On a
 * narrow screen the rail sits above the document instead; with `pinned` (while someone signs) it
 * stays at the top of the screen there, so Finish is always in reach. With no document to show,
 * the rail is a single column.
 */
export function SignLayout({
  rail,
  pinned = false,
  children,
}: {
  rail: ReactNode
  pinned?: boolean
  children?: ReactNode
}) {
  if (!children) {
    return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">{rail}</div>
  }
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start" data-testid="sign-layout">
      <aside
        className={`flex flex-col gap-4 ${pinned ? 'sticky top-0 z-10' : ''} lg:sticky lg:top-4 lg:order-2 lg:max-h-[calc(100dvh-6rem)] lg:w-80 lg:shrink-0 lg:overflow-y-auto xl:w-96`}
        aria-label="Controls"
        data-testid="sign-rail"
      >
        {rail}
      </aside>
      <div className="min-w-0 flex-1 lg:order-1">{children}</div>
    </div>
  )
}
