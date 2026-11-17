import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router'
import { useForYou } from '../apps/for-you/store'
import {
  allEntries,
  entryId,
  MAX_PHONE_PINS,
  pinnedEntries,
  type RailEntry,
  savePhonePins,
  usePhonePins,
} from '../apps/pins'
import { APPS, type AppId, railLinks } from '../apps/registry'
import { openFeedback } from '../feedback/pageShot'
import { useSession } from '../state/session'
import { AccountHeader, appHref, itemClass, useFeedbackEnabled } from './AppRail'
import { Icon, type IconName } from './Icon'
import { TileIcon } from './Launcher'
import { usePinDrag } from './usePinDrag'

/**
 * The phone bar's last tab: opens the Apps sheet, which holds every app, the organization's
 * links, Settings (where Sign out is) and feedback, and where the member chooses the bar's apps
 * (docs/PLAN-phone-tab-bar.md). It is the current tab whenever the page belongs to no app on the bar.
 */
export function AppsTab({
  active,
  onBar: barIds,
  recording,
  waiting,
}: {
  active: AppId | null
  /** The ids on the bar. */
  onBar: ReadonlySet<string>
  recording: boolean
  /** Unread For you mentions with nowhere else on the bar to show. */
  waiting: number
}) {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const onBar = active !== null && barIds.has(active)
  // A recording keeps its dot in view even when Meetings is off the bar, and so do mentions.
  const recordingOff = recording && !barIds.has('meetings')
  const dot = recordingOff || waiting > 0
  const notes = [recordingOff ? 'recording' : null, waiting > 0 ? `${waiting} new` : null].filter(
    Boolean,
  )
  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  // Following any link in the sheet (or Back) closes it, and focus comes back to Apps rather
  // than falling to the top of the page with the unmounted sheet.
  const openRef = useRef(open)
  openRef.current = open
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every location change.
  useEffect(() => {
    if (!openRef.current) return
    setOpen(false)
    buttonRef.current?.focus()
  }, [location.key])

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        aria-label={notes.length > 0 ? `All apps (${notes.join(', ')})` : 'All apps'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-current={onBar ? undefined : 'page'}
        data-testid="apps-menu"
        onClick={() => setOpen((was) => !was)}
        className={itemClass('horizontal', !onBar)}
      >
        <span className="relative">
          <Icon name="apps" className="size-5" />
          {dot ? (
            <span
              data-testid={recordingOff ? 'apps-recording' : 'apps-waiting'}
              aria-hidden="true"
              className="absolute -top-0.5 -right-1 size-2 rounded-full bg-ember ring-2 ring-paper"
            />
          ) : null}
        </span>
        <span className="text-[0.625rem] leading-tight font-medium tracking-tight">Apps</span>
      </button>
      {open ? <AppsSheet active={active} recording={recording} onClose={close} /> : null}
    </>
  )
}

/** How far down the sheet must be dragged before letting go closes it. */
const DISMISS_DRAG = 64

function AppsSheet({
  active,
  recording,
  onClose,
}: {
  active: AppId | null
  recording: boolean
  onClose: () => void
}) {
  const session = useSession()
  const navigate = useNavigate()
  const feedbackOn = useFeedbackEnabled()
  const location = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; id: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [editing, setEditing] = useState(false)
  const waiting = useForYou().view.unseen
  const principal = session.me?.principal
  const onFeedback = location.pathname === '/feedback'
  const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/')

  useEffect(() => {
    // The first app, not the Edit tab bar button above it.
    ref.current?.querySelector<HTMLElement>('a')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const tile =
    'flex min-w-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1.5 text-[0.6875rem] leading-tight font-medium'
  const row =
    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-sm text-ink hover:bg-paper-sunk'

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close apps"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-paper-sunk/60 backdrop-blur-[1px]"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="All apps"
        data-testid="apps-sheet"
        style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
        className="relative flex max-h-[85%] flex-col rounded-t-2xl border-t border-ash bg-paper-raised shadow-float"
      >
        {/* Drag the handle down to close, as on Android and iPhone sheets. */}
        <div
          aria-hidden="true"
          data-testid="apps-sheet-handle"
          className="flex shrink-0 touch-none justify-center pt-2 pb-3"
          onPointerDown={(event) => {
            drag.current = { start: event.clientY, id: event.pointerId }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId) return
            setOffset(Math.max(0, event.clientY - drag.current.start))
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return
            const moved = event.clientY - drag.current.start
            drag.current = null
            setOffset(0)
            if (moved >= DISMISS_DRAG) onClose()
          }}
          onPointerCancel={() => {
            drag.current = null
            setOffset(0)
          }}
        >
          <span className="h-1 w-9 rounded-full bg-ash" />
        </div>

        {/* Only the list scrolls, so the handle stays in reach on a short screen. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <h2 className={HEADING}>{editing ? 'On your tab bar' : 'All apps'}</h2>
            <button
              type="button"
              data-testid="apps-sheet-edit"
              aria-pressed={editing}
              onClick={() => setEditing((was) => !was)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper-sunk hover:text-ink"
            >
              {editing ? (
                'Done'
              ) : (
                <>
                  <Icon name="pencil" className="size-3.5" />
                  Edit tab bar
                </>
              )}
            </button>
          </div>
          {editing ? (
            <TabBarEditor />
          ) : (
            <div className="grid grid-cols-4 gap-x-1 gap-y-2">
              {APPS.map((app) => {
                const current = app.id === active
                const isRecording = app.id === 'meetings' && recording
                const count = app.id === 'for-you' ? waiting : 0
                return (
                  <Link
                    key={app.id}
                    to={current ? app.route : appHref(app)}
                    aria-current={current ? 'page' : undefined}
                    aria-label={
                      isRecording
                        ? `${app.name} (recording)`
                        : count > 0
                          ? `${app.name}, ${count} new`
                          : app.name
                    }
                    data-testid={`apps-sheet-${app.id}`}
                    onPointerEnter={() => void app.preload().catch(() => {})}
                    onClick={(event) => {
                      // Tapping the app already open just closes the sheet, keeping your place.
                      if (!current) return
                      event.preventDefault()
                      onClose()
                    }}
                    className={`${tile} ${current ? 'text-ember' : 'text-ink-soft'}`}
                  >
                    <span
                      className={`relative grid size-11 place-items-center rounded-xl ${current ? 'bg-ember-wash' : 'bg-paper-sunk text-ink'}`}
                    >
                      <Icon name={app.icon} className="size-5" />
                      {isRecording ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-1 right-1 size-2 rounded-full bg-ember ring-2 ring-paper-raised"
                        />
                      ) : null}
                      {count > 0 ? (
                        <span
                          data-testid="apps-sheet-count"
                          aria-hidden="true"
                          className="absolute -top-1 -right-1.5 min-w-4 rounded-full bg-ember px-1 text-center text-[0.625rem] leading-4 font-semibold text-paper ring-2 ring-paper-raised"
                        >
                          {count > 99 ? '99+' : count}
                        </span>
                      ) : null}
                    </span>
                    <span className="max-w-full truncate">{app.label}</span>
                  </Link>
                )
              })}
              {railLinks().map((link) => (
                <a
                  key={link.id}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${link.name} (opens in a new tab)`}
                  data-testid={`apps-sheet-link-${link.id}`}
                  onClick={onClose}
                  className={`${tile} text-ink-soft`}
                >
                  <span className="grid size-11 place-items-center rounded-xl bg-paper-sunk text-ink">
                    <Icon name={link.icon} className="size-5" />
                  </span>
                  <span className="flex max-w-full items-center gap-0.5">
                    <span className="truncate">{link.label}</span>
                    <Icon name="external" className="size-2.5 shrink-0 opacity-75" />
                  </span>
                </a>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-0.5 border-t border-ash/70 pt-2">
            <AccountHeader name={principal?.name} email={principal?.email} />
            <button
              type="button"
              data-testid="settings-link"
              aria-current={onSettings ? 'page' : undefined}
              onClick={() => (onSettings ? onClose() : navigate('/settings'))}
              className={row}
            >
              <Icon name="gear" className="size-4 text-ink-faint" />
              Settings
            </button>
            {feedbackOn ? (
              <button
                type="button"
                data-testid="menu-feedback"
                aria-current={onFeedback ? 'page' : undefined}
                onClick={() => {
                  onClose()
                  // The sheet closes first, so the picture shows the page under it.
                  if (!onFeedback) void openFeedback(navigate, location.pathname)
                }}
                className={row}
              >
                <Icon name="chat" className="size-4 text-ink-faint" />
                Send feedback
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const HEADING = 'text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase'

const EDIT_TILE =
  'flex w-full min-w-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1.5 text-[0.6875rem] leading-tight font-medium text-ink-soft disabled:opacity-40'

/**
 * Edit mode of the Apps sheet: the apps on the member's tab bar, in order (tap to take one off,
 * drag or Alt+arrow to reorder), above every app and link (tap to add or take off). The bar holds
 * at most `MAX_PHONE_PINS`.
 */
function TabBarEditor() {
  const session = useSession()
  const saved = usePhonePins()
  const save = (next: readonly string[]) => {
    savePhonePins(next).catch(() => session.notify("Couldn't save your tab bar. Try again."))
  }
  const savedIds = pinnedEntries(saved).slice(0, MAX_PHONE_PINS).map(entryId)
  const drag = usePinDrag({ enabled: true, ids: savedIds, onDrop: save })
  const onBar = pinnedEntries(drag.dragOrder ?? savedIds)
  const barIds = new Set(onBar.map(entryId))
  const full = onBar.length >= MAX_PHONE_PINS

  const ref = useRef<HTMLDivElement>(null)
  // After the bar changes, focus goes to `testId` (its button may have moved or gone).
  const refocus = (testId: string) =>
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus(),
    )
  const toggle = (id: string) => {
    if (barIds.has(id)) save(savedIds.filter((p) => p !== id))
    else if (!full) save([...savedIds, id])
  }
  const move = (id: string, by: number) => {
    const next = [...savedIds]
    const from = next.indexOf(id)
    const to = from + by
    if (from === -1 || to < 0 || to >= next.length) return
    next.splice(to, 0, ...next.splice(from, 1))
    save(next)
    refocus(`apps-sheet-remove-${id}`)
  }

  return (
    <div ref={ref}>
      <ul
        aria-label="On your tab bar"
        data-testid="apps-sheet-bar"
        className="grid min-h-16 grid-cols-5 gap-x-1 gap-y-2"
      >
        {onBar.map((entry, index) => {
          const id = entryId(entry)
          return (
            <li
              key={id}
              {...drag.itemProps(id)}
              data-testid={`apps-sheet-bar-${id}`}
              className="touch-none"
            >
              <button
                type="button"
                aria-label={`Remove ${entryName(entry)} from the tab bar (position ${index + 1}; Alt and arrow keys move it)`}
                data-testid={`apps-sheet-remove-${id}`}
                onClick={() => {
                  if (drag.takeDragged()) return
                  toggle(id)
                  // Its tile goes; focus moves to the same app in the list below.
                  refocus(`apps-sheet-toggle-${id}`)
                }}
                onKeyDown={(event) => {
                  if (!event.altKey) return
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(id, -1)
                  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(id, 1)
                  else return
                  event.preventDefault()
                }}
                className={EDIT_TILE}
              >
                <TileIcon icon={entryIcon(entry)} badge="minus" />
                <span className="max-w-full truncate">{entryLabel(entry)}</span>
              </button>
            </li>
          )
        })}
        {onBar.length === 0 ? (
          <li className="col-span-5 self-center px-1 text-xs text-ink-faint">
            Only Apps is on the bar. Tap an app below to add it.
          </li>
        ) : null}
      </ul>
      <p data-testid="apps-sheet-help" className="px-1 pt-1 text-xs text-ink-faint">
        {full
          ? `The tab bar holds ${MAX_PHONE_PINS} apps. Remove one to add another.`
          : 'Tap an app to add or remove it. Drag to reorder.'}
      </p>

      <h2 className={`${HEADING} mt-3 border-t border-ash/70 px-1 pt-3 pb-2`}>All apps</h2>
      <ul aria-label="All apps" className="grid grid-cols-4 gap-x-1 gap-y-2">
        {allEntries().map((entry) => {
          const id = entryId(entry)
          const on = barIds.has(id)
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${on ? 'Remove' : 'Add'} ${entryName(entry)} ${on ? 'from' : 'to'} the tab bar`}
                data-testid={`apps-sheet-toggle-${id}`}
                disabled={!on && full}
                onClick={() => toggle(id)}
                className={EDIT_TILE}
              >
                <TileIcon icon={entryIcon(entry)} badge={on ? 'check' : 'plus'} />
                <span className="max-w-full truncate">{entryLabel(entry)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function entryName(entry: RailEntry): string {
  return entry.kind === 'app' ? entry.app.name : entry.link.name
}

function entryLabel(entry: RailEntry): string {
  return entry.kind === 'app' ? entry.app.label : entry.link.label
}

function entryIcon(entry: RailEntry): IconName {
  return entry.kind === 'app' ? entry.app.icon : entry.link.icon
}
