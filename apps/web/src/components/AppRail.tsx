import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { feedbackEnabled } from '../api/feedback'
import { useLive } from '../apps/meetings/live/liveState'
import { forgetRemindersHere } from '../apps/meetings/reminders'
import { APPS, type AppId, type AppManifest, ownerOfPath, railLinks } from '../apps/registry'
import { forgetTaskLists } from '../apps/tasks/useTaskList'
import { forgetTaskMeta } from '../apps/tasks/useTaskMeta'
import { useAuthState } from '../auth/AuthContext'
import { useSession } from '../state/session'
import { AppsTab } from './AppsSheet'
import { BrandMark } from './BrandMark'
import { Icon, type IconName } from './Icon'
import { Menu, type MenuAnchor, MenuItem } from './Menu'

/** Where each app was last open, so switching back lands where you left it. */
const lastLocation = new Map<AppId, string>()

/** Forgets every app's last place (at sign-out, so the next member starts at each app's home). */
export function forgetAppLocations(): void {
  lastLocation.clear()
}

export function rememberAppLocation(pathname: string, search: string): void {
  const app = ownerOfPath(pathname)
  if (app) lastLocation.set(app.id, pathname + search)
}

/** Where switching to `app` lands: where it was last open, else its home. */
export function appHref(app: AppManifest): string {
  return lastLocation.get(app.id) ?? app.route
}

/** Initials for the account button: "Ada Lovelace" → "AL"; the email's first letter without a name. */
export function initials(name: string | undefined, email: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    const first = words[0]?.[0] ?? ''
    const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''
    return (first + last).toUpperCase()
  }
  return (email?.[0] ?? '?').toUpperCase()
}

type Orientation = 'vertical' | 'horizontal'

/**
 * The app rail: one icon per app in `APPS`, then the links that leave Hearth, then Settings
 * and the account menu, in a column on the far left of the shell; the apps scroll when there
 * are more than fit, so the window never does. On phones, a tab bar along the bottom with the
 * apps marked `onPhoneBar` and an Apps tab whose sheet holds everything else.
 */
export function AppRail({ orientation }: { orientation: Orientation }) {
  const location = useLocation()
  const live = useLive()
  const active = ownerOfPath(location.pathname)?.id ?? null
  const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/')
  const recording = live !== null && (live.state === 'recording' || live.state === 'paused')
  const vertical = orientation === 'vertical'

  const apps = APPS.filter((app) => vertical || app.onPhoneBar === true).map((app) => {
    const current = app.id === active
    const isRecording = app.id === 'meetings' && recording
    return (
      <RailItem
        key={app.id}
        orientation={orientation}
        to={current ? app.route : appHref(app)}
        icon={app.icon}
        label={app.label}
        name={isRecording ? `${app.name} (recording)` : app.name}
        current={current}
        testId={`app-switch-${app.id}`}
        onWarm={() => void app.preload().catch(() => {})}
        dot={isRecording}
      />
    )
  })
  const links = !vertical
    ? null
    : railLinks().map((link) => (
        <RailItem
          key={link.id}
          orientation={orientation}
          href={link.href}
          icon={link.icon}
          label={link.label}
          name={`${link.name} (opens in a new tab)`}
          current={false}
          testId={`app-link-${link.id}`}
          external
        />
      ))
  const onFeedback = location.pathname === '/feedback'
  const feedbackHref = feedbackLink(location.pathname)
  const feedbackOn = useFeedbackEnabled()
  const feedback =
    vertical && feedbackOn ? (
      <RailItem
        orientation={orientation}
        to={onFeedback ? '/feedback' : feedbackHref}
        icon="chat"
        label="Feedback"
        name="Send feedback"
        current={onFeedback}
        testId="feedback-link"
        hideLabel
      />
    ) : null
  const settings = vertical ? (
    <RailItem
      orientation={orientation}
      to="/settings"
      icon="gear"
      label="Settings"
      name="Settings"
      current={onSettings}
      testId="settings-link"
      hideLabel
    />
  ) : null
  if (vertical) {
    return (
      <nav
        aria-label="Apps"
        data-testid="app-rail"
        className="shell-rail flex h-full w-[var(--rail-width)] shrink-0 flex-col items-center border-r border-ash bg-paper pt-3 pb-2"
      >
        <BrandMark className="mb-3 size-9 shrink-0" />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain [scrollbar-width:none]">
          {apps}
          {links}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1 pt-2">
          {feedback}
          {settings}
          <AccountButton />
        </div>
      </nav>
    )
  }

  return (
    <nav
      aria-label="Apps"
      data-testid="app-rail"
      className="shell-tabbar shrink-0 border-t border-ash bg-paper-raised pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex">
        {apps}
        <AppsTab active={active} recording={recording} />
      </div>
    </nav>
  )
}

export function useFeedbackEnabled(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void feedbackEnabled().then((v) => live && setOn(v))
    return () => {
      live = false
    }
  }, [])
  return on
}

/** Send feedback, remembering the page it was opened from (docs/plans/2026-11-12-feedback.md). */
export function feedbackLink(pathname: string): string {
  return pathname === '/feedback' ? '/feedback' : `/feedback?from=${encodeURIComponent(pathname)}`
}

export function itemClass(orientation: Orientation, current: boolean): string {
  const shape =
    orientation === 'vertical' ? 'w-15 py-2' : 'h-14 min-w-12 flex-1 basis-0 px-0.5 py-1.5'
  const tone = current
    ? 'bg-ember-wash text-ember'
    : 'text-ink-faint hover:bg-paper-sunk hover:text-ink-soft'
  return `relative flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg ${shape} ${tone}`
}

function RailItem({
  orientation,
  to,
  href,
  icon,
  label,
  name,
  current,
  testId,
  onWarm,
  dot = false,
  external = false,
  hideLabel = false,
}: {
  orientation: Orientation
  to?: string
  href?: string
  icon: IconName
  label: string
  name: string
  current: boolean
  testId: string
  onWarm?: () => void
  dot?: boolean
  external?: boolean
  hideLabel?: boolean
}) {
  const vertical = orientation === 'vertical'
  const body = (
    <>
      <span className="relative">
        {/* The desktop rail's icons are half again the phone bar's (Morgan, Nov 13). */}
        <Icon name={icon} className={vertical ? 'size-7.5' : 'size-5'} />
        {dot ? (
          <span
            data-testid="rail-recording"
            aria-hidden="true"
            className="absolute -top-0.5 -right-1 size-2 rounded-full bg-ember ring-2 ring-paper"
          />
        ) : null}
      </span>
      {hideLabel ? null : (
        <span
          className={`flex max-w-full items-center gap-px leading-tight font-medium tracking-tight ${vertical ? 'text-[0.6875rem]' : 'text-[0.625rem]'}`}
        >
          <span className="truncate">{label}</span>
          {external ? <Icon name="external" className="size-2 shrink-0 opacity-75" /> : null}
        </span>
      )}
    </>
  )
  const common = {
    'aria-label': name,
    title: name,
    'data-testid': testId,
    className: itemClass(orientation, current),
  }
  if (href) {
    return (
      <a {...common} href={href} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    )
  }
  return (
    <Link
      {...common}
      to={to ?? '/'}
      aria-current={current ? 'page' : undefined}
      onPointerEnter={onWarm}
      onFocus={onWarm}
    >
      {body}
    </Link>
  )
}

/** Signs out after forgetting what this member left in memory (app places, task lists, reminders). */
export function useSignOut(): () => void {
  const auth = useAuthState()
  return () => {
    forgetAppLocations()
    // Tasks keeps the last lists, people and projects in memory; they're this member's.
    forgetTaskLists()
    forgetTaskMeta()
    void forgetRemindersHere().finally(auth.signOut)
  }
}

/** The account button at the foot of the desktop rail (on phones, the Apps sheet holds it). */
function AccountButton() {
  const session = useSession()
  const navigate = useNavigate()
  const signOut = useSignOut()
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    setAnchor(null)
    buttonRef.current?.focus()
  }
  const principal = session.me?.principal
  const feedbackOn = useFeedbackEnabled()
  const label = principal ? `Account: ${principal.email}` : 'Account'

  const open = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setAnchor({ x: rect.right + 8, y: rect.bottom, above: true })
  }

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-testid="account-menu"
        ref={buttonRef}
        // While open, the menu's outside-click close would race this button's toggle.
        onPointerDown={(event) => anchor && event.stopPropagation()}
        onClick={(event) => (anchor ? close() : open(event.currentTarget))}
        className={itemClass('vertical', false)}
      >
        <span className="grid size-9 place-items-center rounded-full bg-ash-strong text-xs font-semibold text-paper-raised">
          {initials(principal?.name, principal?.email)}
        </span>
      </button>
      {anchor ? (
        <Menu anchor={anchor} onClose={close} label="Account">
          <AccountHeader name={principal?.name} email={principal?.email} />
          {feedbackOn ? (
            <MenuItem
              icon="chat"
              testId="menu-feedback"
              onSelect={() => {
                setAnchor(null)
                navigate(feedbackLink(window.location.pathname))
              }}
            >
              Send feedback
            </MenuItem>
          ) : null}
          <MenuItem testId="sign-out" onSelect={signOut}>
            Sign out
          </MenuItem>
        </Menu>
      ) : null}
    </>
  )
}

export function AccountHeader({
  name,
  email,
}: {
  name: string | undefined
  email: string | undefined
}): ReactNode {
  return (
    <div className="mb-1 max-w-72 border-b border-ash/70 px-2.5 pt-1.5 pb-2">
      {name ? <p className="truncate text-sm font-medium text-ink">{name}</p> : null}
      <p data-testid="account-email" className="truncate text-xs text-ink-faint" title={email}>
        {email ?? ' '}
      </p>
    </div>
  )
}
