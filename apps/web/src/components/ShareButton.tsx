import { type ReactNode, useState } from 'react'
import { Icon } from './Icon'
import { below, Menu, type MenuAnchor } from './Menu'
import { needsConnection } from './Offline'

// The one way to send something to someone (docs/PLAN-consistency.md, requirement 10): a button
// that says "Share", with "Copy link" and the app's other ways of sharing inside it.

export const shareButtonClass =
  'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink disabled:opacity-50'

/**
 * "Share", opening a menu of `MenuItem`s. `children` gets `close`, to shut the menu when an item
 * is picked.
 */
export function ShareButton({
  children,
  testId = 'share-menu',
  iconOnly = false,
  onOpen,
  disabled,
  title,
  online = true,
  className = shareButtonClass,
}: {
  children: (close: () => void) => ReactNode
  testId?: string
  /** Where words won't fit; the button is still named Share. */
  iconOnly?: boolean
  /** Called as the menu opens, to load what it shows. */
  onOpen?: () => void
  disabled?: boolean
  title?: string
  /** False greys it out with "needs a connection", for sharing that can't wait in the outbox. */
  online?: boolean
  className?: string
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const close = () => setAnchor(null)
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={iconOnly ? 'Share' : undefined}
        disabled={disabled}
        {...needsConnection(online, title)}
        onClick={(event) => {
          if (!anchor) onOpen?.()
          setAnchor(anchor ? null : below(event.currentTarget))
        }}
        className={className}
      >
        <Icon name="share" />
        {iconOnly ? null : 'Share'}
      </button>
      {anchor ? (
        <Menu anchor={anchor} label="Share" onClose={close}>
          {children(close)}
        </Menu>
      ) : null}
    </>
  )
}
