import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router'
import {
  allEntries,
  entryId,
  MAX_PINS,
  pinnedEntries,
  type RailEntry,
  savePins,
  usePins,
} from '../apps/pins'
import type { AppId } from '../apps/registry'
import { useSession } from '../state/session'
import { appHref } from './AppRail'
import { Icon, type IconName } from './Icon'

/**
 * The desktop rail's grid button: opens the launcher, a popover beside the rail with every app.
 * Its top row is the member's pinned apps; the pencil turns on editing, where a click pins or
 * unpins an app and the pinned ones drag (or Alt+arrow) into a new order.
 */
export function LauncherButton({ active, className }: { active: AppId | null; className: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    setAnchor(null)
    buttonRef.current?.focus()
  }
  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        aria-label="All apps"
        title="All apps"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-testid="launcher-button"
        // While open, the popover's outside-click close would race this button's toggle.
        onPointerDown={(event) => anchor && event.stopPropagation()}
        onClick={(event) =>
          anchor ? close() : setAnchor(event.currentTarget.getBoundingClientRect())
        }
        className={className}
      >
        <Icon name="apps" className="size-6.25" />
      </button>
      {anchor ? <Launcher anchor={anchor} active={active} onClose={close} /> : null}
    </>
  )
}

function Launcher({
  anchor,
  active,
  onClose,
}: {
  anchor: DOMRect
  active: AppId | null
  onClose: () => void
}) {
  const location = useLocation()
  const session = useSession()
  const saved = usePins()
  const [editing, setEditing] = useState(false)
  // While a pinned app is dragged, the order shown; saved when it's dropped.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const drag = useRef<{ id: string; pointer: number } | null>(null)
  // A drag that moved an app ends in a click on it, which mustn't also unpin it.
  const dragged = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const order = dragOrder ?? [...saved]
  const pinned = pinnedEntries(order)
  const pinnedIds = new Set(pinned.map(entryId))
  const full = pinned.length >= MAX_PINS

  const save = (next: readonly string[]) => {
    savePins(next).catch(() => session.notify("Couldn't save your pinned apps. Try again."))
  }
  // Ids the instance doesn't have (say, Chat without a chat link) keep no slot.
  const toggle = (id: string) => {
    const known = pinned.map(entryId)
    if (pinnedIds.has(id)) save(known.filter((p) => p !== id))
    else if (!full) save([...known, id])
  }
  const move = (id: string, by: number) => {
    const known = pinned.map(entryId)
    const from = known.indexOf(id)
    const to = from + by
    if (from === -1 || to < 0 || to >= known.length) return
    known.splice(to, 0, ...known.splice(from, 1))
    save(known)
  }

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('a, button')?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    const onDown = (event: globalThis.PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [])

  // Following a link closes the launcher.
  const startKey = useRef(location.key)
  useEffect(() => {
    if (location.key !== startKey.current) onCloseRef.current()
  }, [location.key])

  const onDragStart = (event: PointerEvent<HTMLElement>, id: string) => {
    if (!editing || event.button !== 0) return
    drag.current = { id, pointer: event.pointerId }
    dragged.current = false
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragOrder(pinned.map(entryId))
  }
  const onDragMove = (event: PointerEvent<HTMLElement>) => {
    const dragging = drag.current
    if (dragging?.pointer !== event.pointerId) return
    const over = document
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-pin-id]')?.dataset.pinId
    if (!over || over === dragging.id) return
    dragged.current = true
    setDragOrder((was) => {
      const next = [...(was ?? [])]
      const from = next.indexOf(dragging.id)
      const to = next.indexOf(over)
      if (from === -1 || to === -1) return was
      next.splice(to, 0, ...next.splice(from, 1))
      return next
    })
  }
  const onDragEnd = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    const next = dragOrder
    setDragOrder(null)
    if (next && next.join() !== pinnedEntries(saved).map(entryId).join()) save(next)
  }
  const onPinnedKey = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (!editing || !event.altKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(id, -1)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(id, 1)
    else return
    event.preventDefault()
  }

  const top = Math.max(8, Math.min(anchor.bottom, window.innerHeight - 8))
  const heading = 'text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase'

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="All apps"
      data-testid="launcher"
      data-editing={editing ? 'true' : undefined}
      style={{ left: anchor.right + 8, bottom: window.innerHeight - top }}
      className="fixed z-40 flex max-h-[calc(100dvh-1rem)] w-[22rem] max-w-[calc(100vw-var(--rail-width)-1rem)] flex-col rounded-2xl border border-ash bg-paper-raised shadow-float"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <h2 className={heading}>Your pinned apps</h2>
          <button
            type="button"
            data-testid="launcher-edit"
            aria-pressed={editing}
            onClick={() => setEditing((was) => !was)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper-sunk hover:text-ink"
          >
            {editing ? (
              'Done'
            ) : (
              <>
                <Icon name="pencil" className="size-3.5" />
                Edit
              </>
            )}
          </button>
        </div>
        {editing ? (
          <p data-testid="launcher-help" className="px-1 pb-2 text-xs text-ink-faint">
            Click an app below to pin or unpin it. Drag pinned apps to reorder. Up to {MAX_PINS}.
          </p>
        ) : null}
        <ul
          aria-label="Pinned apps"
          data-testid="launcher-pinned"
          className="grid min-h-16 grid-cols-4 gap-x-1 gap-y-2"
        >
          {pinned.map((entry, index) => {
            const id = entryId(entry)
            return (
              <li
                key={id}
                data-pin-id={id}
                data-testid={`launcher-pinned-${id}`}
                className={editing ? 'cursor-grab touch-none active:cursor-grabbing' : undefined}
                onPointerDown={(event) => onDragStart(event, id)}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
              >
                {editing ? (
                  <button
                    type="button"
                    aria-label={`Unpin ${entryName(entry)} (position ${index + 1}; Alt and arrow keys move it)`}
                    data-testid={`launcher-unpin-${id}`}
                    onClick={() => {
                      if (dragged.current) dragged.current = false
                      else toggle(id)
                    }}
                    onKeyDown={(event) => onPinnedKey(event, id)}
                    className={TILE}
                  >
                    <TileIcon icon={entryIcon(entry)} badge="minus" />
                    <TileLabel entry={entry} />
                  </button>
                ) : (
                  <EntryLink
                    entry={entry}
                    current={entryIsActive(entry, active)}
                    onClose={onClose}
                  />
                )}
              </li>
            )
          })}
          {pinned.length === 0 ? (
            <li className="col-span-4 self-center px-1 text-xs text-ink-faint">
              Nothing pinned. {editing ? 'Click an app below to pin it.' : 'Edit to pin apps.'}
            </li>
          ) : null}
        </ul>

        <h2 className={`${heading} mt-3 border-t border-ash/70 px-1 pt-3 pb-2`}>All apps</h2>
        <ul aria-label="All apps" className="grid grid-cols-4 gap-x-1 gap-y-2">
          {allEntries().map((entry) => {
            const id = entryId(entry)
            const isPinned = pinnedIds.has(id)
            return (
              <li key={id}>
                {editing ? (
                  <button
                    type="button"
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${entryName(entry)}`}
                    data-testid={`launcher-toggle-${id}`}
                    disabled={!isPinned && full}
                    title={
                      !isPinned && full
                        ? `Unpin an app to add another (${MAX_PINS} at most)`
                        : undefined
                    }
                    onClick={() => toggle(id)}
                    className={`${TILE} disabled:opacity-45`}
                  >
                    <TileIcon icon={entryIcon(entry)} badge={isPinned ? 'check' : 'plus'} />
                    <TileLabel entry={entry} />
                  </button>
                ) : (
                  <EntryLink
                    entry={entry}
                    current={entryIsActive(entry, active)}
                    onClose={onClose}
                    testId={`launcher-app-${id}`}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>,
    document.body,
  )
}

const TILE =
  'flex w-full min-w-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1.5 text-[0.6875rem] leading-tight font-medium text-ink-soft hover:bg-paper-sunk'

function entryName(entry: RailEntry): string {
  return entry.kind === 'app' ? entry.app.name : entry.link.name
}

function entryIcon(entry: RailEntry): IconName {
  return entry.kind === 'app' ? entry.app.icon : entry.link.icon
}

function entryIsActive(entry: RailEntry, active: AppId | null): boolean {
  return entry.kind === 'app' && entry.app.id === active
}

function TileIcon({
  icon,
  badge,
  current = false,
}: {
  icon: IconName
  badge?: 'plus' | 'minus' | 'check'
  current?: boolean
}) {
  return (
    <span
      className={`relative grid size-11 place-items-center rounded-xl ${current ? 'bg-ember-wash text-ember' : 'bg-paper-sunk text-ink'}`}
    >
      <Icon name={icon} className="size-5.5" />
      {badge ? (
        <span
          aria-hidden="true"
          className={`absolute -top-1 -right-1 grid size-4.5 place-items-center rounded-full text-[0.75rem] leading-none font-bold ring-2 ring-paper-raised ${badge === 'check' ? 'bg-ember text-paper-raised' : 'bg-ash-strong text-paper-raised'}`}
        >
          {badge === 'plus' ? '+' : badge === 'minus' ? '−' : '✓'}
        </span>
      ) : null}
    </span>
  )
}

function TileLabel({ entry }: { entry: RailEntry }) {
  return (
    <span className="flex max-w-full items-center gap-0.5">
      <span className="truncate">{entry.kind === 'app' ? entry.app.label : entry.link.label}</span>
      {entry.kind === 'link' ? (
        <Icon name="external" className="size-2.5 shrink-0 opacity-75" />
      ) : null}
    </span>
  )
}

function EntryLink({
  entry,
  current,
  onClose,
  testId,
}: {
  entry: RailEntry
  current: boolean
  onClose: () => void
  testId?: string
}) {
  const body = (
    <>
      <TileIcon icon={entryIcon(entry)} current={current} />
      <TileLabel entry={entry} />
    </>
  )
  if (entry.kind === 'link') {
    return (
      <a
        href={entry.link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${entry.link.name} (opens in a new tab)`}
        data-testid={testId}
        onClick={onClose}
        className={TILE}
      >
        {body}
      </a>
    )
  }
  const { app } = entry
  return (
    <Link
      to={current ? app.route : appHref(app)}
      aria-current={current ? 'page' : undefined}
      aria-label={app.name}
      data-testid={testId}
      onPointerEnter={() => void app.preload().catch(() => {})}
      onClick={(event) => {
        // The app already open: just close, keeping your place.
        if (!current) return
        event.preventDefault()
        onClose()
      }}
      className={`${TILE} ${current ? 'text-ember' : ''}`}
    >
      {body}
    </Link>
  )
}
