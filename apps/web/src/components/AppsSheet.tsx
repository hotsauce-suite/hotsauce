import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router'
import { APPS, type AppId, railLinks } from '../apps/registry'
import { useSession } from '../state/session'
import {
  AccountHeader,
  appHref,
  feedbackLink,
  itemClass,
  useFeedbackEnabled,
  useSignOut,
} from './AppRail'
import { Icon } from './Icon'

/**
 * The phone bar's last tab: opens the Apps sheet, which holds every app, the organization's
 * links, Settings, feedback and the account. It is the
 * current tab whenever the page belongs to no app on the bar.
 */
export function AppsTab({ active, recording }: { active: AppId | null; recording: boolean }) {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const onBar = APPS.some((app) => app.id === active && app.onPhoneBar === true)
  // A recording keeps its dot in view even when Meetings is off the bar.
  const meetingsOnBar = APPS.some((app) => app.id === 'meetings' && app.onPhoneBar === true)
  const dot = recording && !meetingsOnBar
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
        aria-label={dot ? 'All apps (recording)' : 'All apps'}
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
              data-testid="apps-recording"
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
  const signOut = useSignOut()
  const feedbackOn = useFeedbackEnabled()
  const location = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; id: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const principal = session.me?.principal
  const onFeedback = location.pathname === '/feedback'
  const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/')

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('a, button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
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
          <h2 className="px-1 pb-2 text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase">
            All apps
          </h2>
          <div className="grid grid-cols-4 gap-x-1 gap-y-2">
            {APPS.map((app) => {
              const current = app.id === active
              const isRecording = app.id === 'meetings' && recording
              return (
                <Link
                  key={app.id}
                  to={current ? app.route : appHref(app)}
                  aria-current={current ? 'page' : undefined}
                  aria-label={isRecording ? `${app.name} (recording)` : app.name}
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
                onClick={() => (onFeedback ? onClose() : navigate(feedbackLink(location.pathname)))}
                className={row}
              >
                <Icon name="chat" className="size-4 text-ink-faint" />
                Send feedback
              </button>
            ) : null}
            <button type="button" data-testid="sign-out" onClick={signOut} className={row}>
              <span aria-hidden="true" className="size-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
