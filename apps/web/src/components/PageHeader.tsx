import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useShell } from './AppShell'
import { Icon, type IconName } from './Icon'
import { below, Menu, type MenuAnchor, MenuItem } from './Menu'
import { IconButton } from './TopBar'

// The one top bar (docs/PLAN-consistency.md, round 2): on a phone the menu, then the title, then
// the page's controls, ending in the app's one red button at the top right.

/** The top bar of a page that isn't a document. */
export function PageHeader({
  title,
  children,
  menu = true,
}: {
  title: ReactNode
  children?: ReactNode
  /** False for a page whose app has no sidebar to open. */
  menu?: boolean
}) {
  const { compact, openDrawer } = useShell()
  return (
    <header
      data-testid="page-header"
      className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2 border-b border-ash/70 bg-paper/80 px-2 backdrop-blur-sm md:px-4"
    >
      {compact && menu ? (
        <IconButton icon="menu" label="Open sidebar" onClick={openDrawer} />
      ) : null}
      <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold tracking-tight text-ink">
        {title}
      </h1>
      {children}
    </header>
  )
}

const mainButtonClass =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-ember px-3 text-sm font-medium whitespace-nowrap text-paper-raised hover:bg-ember-strong disabled:cursor-not-allowed disabled:opacity-50'

/** A quieter button beside the main one, at the same height. */
export const secondaryHeaderButton =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-ash-strong px-3 text-sm whitespace-nowrap text-ink hover:border-ember disabled:cursor-not-allowed disabled:opacity-50'

interface MainButtonProps {
  /** The words, shown at every width: "New task", "Record a clip". */
  children: ReactNode
  icon?: IconName
  /** A mark of the button's own in place of an icon (the Clips record dot). */
  lead?: ReactNode
  /** A link to the page that makes the thing, or… */
  to?: string
  /** …what a press does. */
  onClick?: () => void
  disabled?: boolean
  title?: string
  testId?: string
  ariaHasPopup?: 'menu'
  ariaExpanded?: boolean
  /** Set by `needsConnection` while offline. */
  'data-offline'?: string
}

/**
 * An app's one red button. It is the last control in the page's top bar, so it sits at the top
 * right on a computer and on a phone, and it always shows its words.
 */
export function MainButton({
  children,
  icon,
  lead,
  to,
  onClick,
  disabled,
  title,
  testId,
  ariaHasPopup,
  ariaExpanded,
  'data-offline': offline,
}: MainButtonProps) {
  const inner = (
    <>
      {lead ?? (icon ? <Icon name={icon} /> : null)}
      <span>{children}</span>
    </>
  )
  if (to !== undefined) {
    return (
      <Link to={to} data-main-button data-testid={testId} title={title} className={mainButtonClass}>
        {inner}
      </Link>
    )
  }
  return (
    <button
      type="button"
      data-main-button
      data-testid={testId}
      title={title}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      data-offline={offline}
      onClick={onClick}
      disabled={disabled}
      className={mainButtonClass}
    >
      {inner}
    </button>
  )
}

/**
 * A main button that makes an untitled thing, named on its own page. With more than one space it
 * first asks whose it is ("Personal" or "Team"); with one, a press makes it.
 */
export function NewInSpaceButton({
  children,
  spaces,
  onCreate,
  busy = false,
  testId,
  secondary = false,
}: {
  children: ReactNode
  spaces: { name: string; label: string }[]
  onCreate: (space: string) => void
  busy?: boolean
  testId: string
  /** The quieter button beside the main one that asks the same question ("Import"). */
  secondary?: boolean
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [button, setButton] = useState<HTMLSpanElement | null>(null)
  // The menu closes itself on a press outside it, which this button is: a press that began with
  // the menu open closes it and stops there.
  const openAtPress = useRef(false)
  const only = spaces.length === 1 ? spaces[0] : undefined
  const press = () => {
    if (only) onCreate(only.name)
    else if (openAtPress.current) setAnchor(null)
    else setAnchor(button ? below(button) : null)
    openAtPress.current = false
  }
  const popup = only ? {} : { 'aria-haspopup': 'menu' as const, 'aria-expanded': anchor !== null }
  return (
    <span
      ref={setButton}
      className="flex shrink-0"
      onPointerDownCapture={() => {
        openAtPress.current = anchor !== null
      }}
    >
      {secondary ? (
        <button
          type="button"
          data-testid={testId}
          disabled={busy}
          onClick={press}
          className={secondaryHeaderButton}
          {...popup}
        >
          {children}
        </button>
      ) : (
        <MainButton
          icon="plus"
          testId={testId}
          disabled={busy}
          {...(only ? {} : { ariaHasPopup: 'menu' as const, ariaExpanded: anchor !== null })}
          onClick={press}
        >
          {children}
        </MainButton>
      )}
      {anchor ? (
        <Menu anchor={anchor} label="Whose is it?" onClose={() => setAnchor(null)}>
          {spaces.map((s) => (
            <MenuItem
              key={s.name}
              testId={`${testId}-in-${s.name}`}
              onSelect={() => {
                setAnchor(null)
                onCreate(s.name)
              }}
            >
              {s.label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
    </span>
  )
}

/**
 * On the page of a thing that was just made untitled: puts the cursor in its name, selected, so
 * typing names it.
 */
export function useNameWhenFresh(
  fresh: boolean,
  ready: boolean,
  selector: string,
  /** The name it was made with. Once it has a name of its own, a reload or Back leaves it be. */
  untitled: string,
) {
  useEffect(() => {
    if (!fresh || !ready) return
    const input = document.querySelector<HTMLInputElement>(selector)
    if (!input || input.value !== untitled) return
    input.focus()
    input.select()
  }, [fresh, ready, selector, untitled])
}
