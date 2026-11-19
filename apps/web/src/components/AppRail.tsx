import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useLocation, useNavigate, useRouteLoaderData } from 'react-router'
import { feedbackEnabled } from '../api/feedback'
import type { Health } from '../api/types'
import { forgetForYou, useForYou } from '../apps/for-you/store'
import { useLive } from '../apps/meetings/live/liveState'
import { forgetRemindersHere } from '../apps/meetings/reminders'
import {
  entryId,
  forgetPins,
  MAX_PHONE_PINS,
  pinnedEntries,
  type RailEntry,
  usePhonePins,
  usePins,
} from '../apps/pins'
import { APPS, type AppId, type AppManifest, ownerOfPath } from '../apps/registry'
import { forgetTaskLists } from '../apps/tasks/useTaskList'
import { forgetTaskMeta } from '../apps/tasks/useTaskMeta'
import { useAuthState } from '../auth/AuthContext'
import { org, product } from '../brand/product'
import { feedbackLink, openFeedback } from '../feedback/pageShot'
import { GO_KEYS } from '../keyboard/catalog'
import { useOnline } from '../lib/connection'
import { HELP_DOCS } from '../lib/helpLinks'
import { installedMacAppVersion, macVersionLabel } from '../lib/macAppVersion'
import { chooseTheme, currentTheme, customIdOf, type ThemeChoice } from '../lib/theme'
import { MusicPanel, musicStatus } from '../music/MusicPanel'
import { useMusic } from '../music/useMusic'
import { initials, MemberFace } from '../profile/MemberFace'
import { usePhotoPicker } from '../profile/usePhotoPicker'
import { Mascot } from '../rail/Mascot'
import { type Tip, type TipHandlers, useRailTip } from '../rail/RailTip'
import { setRailWide, useRailWide } from '../rail/railWide'
import { useSession } from '../state/session'
import { AppsTab } from './AppsSheet'
import { BrandMark } from './BrandMark'
import { Icon, type IconName } from './Icon'
import { EDIT_PINS, LauncherButton } from './Launcher'
import { MAC_APP_SETTINGS, WHATS_NEW } from './MacApp'
import { Menu, type MenuAnchor, MenuItem, menuItemClass } from './Menu'
import { NEEDS_CONNECTION } from './Offline'

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

// The account button's initials live with the face that shows them.
export { initials }

type Orientation = 'vertical' | 'horizontal'

/**
 * The app rail: the member's pinned apps (docs/PLAN-pinned-rail.md), the open app below them when
 * it isn't pinned, then the launcher's grid button (every app) and the account menu (Settings,
 * the theme, music, help), in a column on the far left of the shell; the apps scroll when there
 * are more than fit, so the window never does. The logo at the top widens the rail, so each icon
 * sits beside its name (docs/PLAN-rail-account-menu.md). On phones, a tab bar along the bottom with the apps the member chose for it
 * (docs/PLAN-phone-tab-bar.md) and an Apps tab whose sheet holds everything else.
 */
export function AppRail({
  orientation,
  onShortcuts,
}: {
  orientation: Orientation
  /** Opens the keyboard shortcuts sheet, which the shell owns. */
  onShortcuts?: () => void
}) {
  const location = useLocation()
  const live = useLive()
  const active = ownerOfPath(location.pathname)?.id ?? null
  const recording = live !== null && (live.state === 'recording' || live.state === 'paused')
  const vertical = orientation === 'vertical'
  const wide = useRailWide() && vertical
  const pins = usePins()
  const phonePins = usePhonePins(!vertical)
  const waiting = useForYou().view.unseen
  const onPhoneBar = vertical ? [] : pinnedEntries(phonePins).slice(0, MAX_PHONE_PINS)
  const phoneIds = new Set(onPhoneBar.map(entryId))
  // For you's count: on its own entry when it's there (always on the rail); on the phone bar
  // without it, on Today, whose tile lists them; with neither, as a dot on Apps.
  const countOn =
    vertical || phoneIds.has('for-you') ? 'for-you' : phoneIds.has('today') ? 'today' : null

  const appItem = (app: AppManifest) => {
    const current = app.id === active
    const isRecording = app.id === 'meetings' && recording
    const count = app.id === countOn ? waiting : 0
    return (
      <RailItem
        key={app.id}
        orientation={orientation}
        wide={wide}
        to={current ? app.route : appHref(app)}
        icon={app.icon}
        label={app.label}
        about={app.about}
        name={
          isRecording
            ? `${app.name} (recording)`
            : count > 0
              ? `${app.name}, ${count} new`
              : app.name
        }
        current={current}
        testId={`app-switch-${app.id}`}
        goKey={GO_KEYS[app.id]}
        onWarm={() => void app.preload().catch(() => {})}
        dot={isRecording}
        count={count}
      />
    )
  }
  const entryItem = (entry: RailEntry) =>
    entry.kind === 'app' ? (
      appItem(entry.app)
    ) : (
      <RailItem
        key={entry.link.id}
        orientation={orientation}
        wide={wide}
        href={entry.link.href}
        icon={entry.link.icon}
        label={entry.link.label}
        name={`${entry.link.name} (opens in a new tab)`}
        current={false}
        testId={`app-link-${entry.link.id}`}
        external
      />
    )
  const pinned = vertical ? pinnedEntries(pins) : []
  // The open app stays in view below the pins, so the rail always shows where you are.
  const openApp = APPS.find((app) => app.id === active)
  const unpinned =
    vertical && openApp && !pinned.some((entry) => entryId(entry) === openApp.id) ? openApp : null
  const apps = (vertical ? pinned : onPhoneBar).map(entryItem)
  if (vertical) {
    return (
      <nav
        aria-label="Apps"
        data-testid="app-rail"
        onKeyDown={(e) => moveInRail(e, 'ArrowDown', 'ArrowUp')}
        data-wide={wide ? '' : undefined}
        className="shell-rail flex h-full w-[var(--rail-width)] shrink-0 flex-col items-center overflow-hidden border-r border-ash bg-paper pt-3 pb-2"
      >
        <RailToggle wide={wide} />
        <RailApps>
          {apps}
          {unpinned ? (
            <>
              <span
                aria-hidden="true"
                className={`my-1 h-px shrink-0 bg-ash ${wide ? 'w-[calc(100%-1.5rem)]' : 'w-8'}`}
              />
              {appItem(unpinned)}
            </>
          ) : null}
        </RailApps>
        <div className="flex w-full shrink-0 flex-col items-center gap-1 pt-2">
          <RailMascot />
          <LauncherButton
            active={active}
            wide={wide}
            className={itemClass('vertical', false, wide)}
          />
          <AccountButton wide={wide} onShortcuts={onShortcuts} />
        </div>
      </nav>
    )
  }

  return (
    <nav
      aria-label="Apps"
      data-testid="app-rail"
      onKeyDown={(e) => moveInRail(e, 'ArrowRight', 'ArrowLeft')}
      className="shell-tabbar shrink-0 border-t border-ash bg-paper-raised pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex">
        {apps}
        <AppsTab
          active={active}
          onBar={phoneIds}
          recording={recording}
          waiting={countOn === null ? waiting : 0}
        />
      </div>
    </nav>
  )
}

/**
 * Arrow keys move between the rail's items (down and up on the desktop rail, right and left on
 * the phone bar), and Home and End go to the first and last, as in a toolbar.
 */
function moveInRail(e: KeyboardEvent<HTMLElement>, next: string, previous: string) {
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
  if (![next, previous, 'Home', 'End'].includes(e.key)) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button')].filter(
    (el) => !el.hasAttribute('disabled'),
  )
  const at = items.indexOf(document.activeElement as HTMLElement)
  if (at === -1) return
  const to =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : Math.min(items.length - 1, Math.max(0, at + (e.key === next ? 1 : -1)))
  e.preventDefault()
  items[to]?.focus()
}

/**
 * The rail's scrolling list of apps. The scrollbar is hidden, so while more apps sit below the
 * fold the list fades out at the bottom (`data-more`), as a hint to scroll.
 */
function RailApps({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const list = ref.current
    if (!list) return
    const check = () => setMore(list.scrollTop + list.clientHeight < list.scrollHeight - 1)
    check()
    list.addEventListener('scroll', check, { passive: true })
    const observer = new ResizeObserver(check)
    observer.observe(list)
    // Pinning an app grows the list's content, not the list itself: look again when apps change.
    const added = new MutationObserver(check)
    added.observe(list, { childList: true })
    return () => {
      list.removeEventListener('scroll', check)
      observer.disconnect()
      added.disconnect()
    }
  }, [])
  return (
    <div
      ref={ref}
      data-testid="rail-apps"
      data-more={more ? 'true' : undefined}
      className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 scroll-pb-10 overflow-y-auto overscroll-contain [scrollbar-width:none] data-[more]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
    >
      {children}
    </div>
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

// Send feedback, remembering the page it was opened from (docs/plans/2026-11-12-feedback.md).
export { feedbackLink }

export function itemClass(orientation: Orientation, current: boolean, wide = false): string {
  const tone = current
    ? 'bg-ember-wash text-ember'
    : 'text-ink-faint hover:bg-paper-sunk hover:text-ink-soft'
  // Wide: a row, the icon beside the name.
  if (wide) {
    return `relative flex w-[calc(100%-1rem)] shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-left ${tone}`
  }
  const shape =
    orientation === 'vertical' ? 'w-13.5 py-1.5' : 'h-14 min-w-12 flex-1 basis-0 px-0.5 py-1.5'
  return `relative flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg ${shape} ${tone}`
}

/**
 * The logo at the top of the rail: a click widens the rail so each icon sits beside its name, and
 * another narrows it again. The choice is kept on this device (rail/railWide.ts).
 */
function RailToggle({ wide }: { wide: boolean }) {
  const label = wide ? 'Hide the names' : 'Show the names'
  const tip = useRailTip({
    title: label,
    about: wide ? 'Narrow the menu back to icons.' : 'Widen the menu so each icon has its name.',
  })
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-pressed={wide}
        data-testid="rail-toggle"
        {...tip.handlers}
        onClick={() => setRailWide(!wide)}
        className={`mb-3 flex shrink-0 items-center gap-2.5 rounded-lg hover:bg-paper-sunk ${
          wide ? 'w-[calc(100%-1rem)] px-2.5 py-1' : 'p-1'
        }`}
      >
        <BrandMark className="rail-logo size-8 shrink-0" />
        {wide ? (
          <span className="truncate font-display text-base font-semibold tracking-tight text-ink">
            {org() || product()}
          </span>
        ) : null}
      </button>
      {tip.node}
    </>
  )
}

function RailItem({
  orientation,
  wide = false,
  about,
  to,
  href,
  icon,
  label,
  name,
  current,
  testId,
  onWarm,
  onClick,
  dot = false,
  count = 0,
  external = false,
  goKey,
}: {
  orientation: Orientation
  /** The wide desktop rail: the icon beside the name, not over it. */
  wide?: boolean
  /** One line saying what it is, for the tip. */
  about?: string
  to?: string
  href?: string
  icon: IconName
  label: string
  name: string
  current: boolean
  testId: string
  onWarm?: () => void
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined
  dot?: boolean
  /** A number on the icon (For you's waiting items); none at zero. */
  count?: number
  external?: boolean
  /** Its `g` shortcut's letter, shown in the tip. */
  goKey?: string
}) {
  const vertical = orientation === 'vertical'
  const tipText: Tip = { title: label }
  if (about) tipText.about = about
  else if (external) tipText.about = 'Opens in a new tab.'
  if (goKey) tipText.keys = `g ${goKey}`
  const tip = useRailTip(tipText)
  const body = (
    <>
      <span className="relative">
        {/* The desktop rail's icons are a quarter bigger than the phone bar's (Morgan, Nov 13). */}
        <Icon name={icon} className={wide ? 'size-5.5' : vertical ? 'size-6.25' : 'size-5'} />
        {dot ? (
          <span
            data-testid="rail-recording"
            aria-hidden="true"
            className="absolute -top-0.5 -right-1 size-2 rounded-full bg-ember ring-2 ring-paper"
          />
        ) : null}
        {count > 0 ? (
          <span
            data-testid="rail-count"
            aria-hidden="true"
            className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-ember px-1 text-center text-[0.625rem] leading-4 font-semibold text-paper ring-2 ring-paper"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </span>
      <span
        className={
          wide
            ? 'flex min-w-0 flex-1 items-center gap-1 text-sm font-medium'
            : `flex max-w-full items-center gap-px leading-tight font-medium tracking-tight ${vertical ? 'text-[0.65625rem]' : 'text-[0.625rem]'}`
        }
      >
        <span className="truncate">{label}</span>
        {external ? (
          <Icon name="external" className={`${wide ? 'size-3' : 'size-2'} shrink-0 opacity-75`} />
        ) : null}
      </span>
    </>
  )
  const common = {
    'aria-label': name,
    'data-testid': testId,
    className: itemClass(orientation, current, wide),
  }
  // The phone's tab bar has no hover, so no tip.
  const tips: Partial<TipHandlers> = vertical ? tip.handlers : {}
  if (href) {
    return (
      <>
        <ExternalRailItem common={common} tips={tips} href={href} name={name} body={body} />
        {vertical ? tip.node : null}
      </>
    )
  }
  return (
    <>
      <Link
        {...common}
        {...tips}
        to={to ?? '/'}
        aria-current={current ? 'page' : undefined}
        onPointerEnter={(event) => {
          onWarm?.()
          tips.onPointerEnter?.(event)
        }}
        onFocus={(event) => {
          onWarm?.()
          tips.onFocus?.(event)
        }}
        onClick={onClick}
      >
        {body}
      </Link>
      {vertical ? tip.node : null}
    </>
  )
}

/** Signs out after forgetting what this member left in memory (app places, task lists, reminders). */
export function useSignOut(): () => void {
  const auth = useAuthState()
  return () => {
    forgetAppLocations()
    forgetPins()
    forgetForYou()
    // Tasks keeps the last lists, people and projects in memory; they're this member's.
    forgetTaskLists()
    forgetTaskMeta()
    void forgetRemindersHere().finally(auth.signOut)
  }
}

/**
 * The account button at the foot of the desktop rail, and its menu: who's signed in, the theme,
 * music, Settings, the keyboard shortcuts, help, feedback and the versions
 * (docs/PLAN-rail-account-menu.md, requirements 6 to 10).
 */
function AccountButton({
  wide,
  onShortcuts,
}: {
  wide: boolean
  onShortcuts?: (() => void) | undefined
}) {
  const session = useSession()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Settings is reached from here, so on its pages this button is the one lit.
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/')
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    setAnchor(null)
    buttonRef.current?.focus()
  }
  const principal = session.me?.principal
  const feedbackOn = useFeedbackEnabled()
  const label = principal ? `Account: ${principal.email}` : 'Account'
  // Outside the menu, so a pick still lands if the menu closed while the file dialog was open.
  const photos = usePhotoPicker()
  const tip = useRailTip({
    title: principal?.name || 'Account',
    about: 'Settings, light and dark, music, help and feedback.',
  })

  const open = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    photos.clearError()
    setAnchor({ x: rect.right + 8, y: rect.bottom, above: true })
  }
  /** Leaves the menu for somewhere else: focus goes with it, not back to the button. */
  const go = (then: () => void) => () => {
    setAnchor(null)
    then()
  }

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-testid="account-menu"
        data-current={onSettings ? '' : undefined}
        ref={buttonRef}
        {...tip.handlers}
        // While open, the menu's outside-click close would race this button's toggle.
        onPointerDown={(event) => {
          tip.handlers.onPointerDown()
          if (anchor) event.stopPropagation()
        }}
        onClick={(event) => (anchor ? close() : open(event.currentTarget))}
        className={itemClass('vertical', onSettings, wide)}
      >
        <MemberFace
          name={principal?.name}
          email={principal?.email}
          photo={session.me?.photo}
          className={wide ? 'size-6 text-[0.625rem]' : 'size-7.5 text-[0.6875rem]'}
        />
        {wide ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {principal?.name || principal?.email || 'Account'}
          </span>
        ) : null}
      </button>
      {anchor ? null : tip.node}
      {photos.input}
      {anchor ? (
        <Menu anchor={anchor} onClose={close} label="Account">
          <PhotoPicker.Provider value={photos}>
            <div className="w-64" data-testid="account-menu-body">
              <AccountHeader name={principal?.name} email={principal?.email} face />
              {photos.error ? (
                <p
                  role="alert"
                  data-testid="photo-error"
                  className="px-2.5 pb-1.5 text-xs text-ember-strong"
                >
                  {photos.error}
                </p>
              ) : null}
              <ThemeSwitch onMore={go(() => navigate('/settings/appearance'))} />
              <MusicMenuRow />
              <MenuDivider />
              <MenuItem
                icon="gear"
                testId="menu-settings"
                keys={`g ${GO_KEYS.settings}`}
                onSelect={go(() => navigate('/settings'))}
              >
                Settings
              </MenuItem>
              {onShortcuts ? (
                <MenuItem
                  icon="keyboard"
                  testId="menu-shortcuts"
                  keys="?"
                  onSelect={go(onShortcuts)}
                >
                  Keyboard shortcuts
                </MenuItem>
              ) : null}
              <MenuItem
                icon="pin"
                testId="menu-edit-pins"
                onSelect={go(() => window.dispatchEvent(new Event(EDIT_PINS)))}
              >
                Edit pinned apps
              </MenuItem>
              <MenuDivider />
              <MenuItem
                icon="sparkle"
                testId="menu-whats-new"
                onSelect={go(() => navigate(WHATS_NEW))}
              >
                What’s new
              </MenuItem>
              {offerMacApp() ? (
                <MenuItem
                  icon="laptop"
                  testId="menu-mac-app"
                  onSelect={go(() => navigate(MAC_APP_SETTINGS))}
                >
                  Get the Mac app
                </MenuItem>
              ) : null}
              <a
                role="menuitem"
                href={HELP_DOCS}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="menu-help"
                onClick={() => setAnchor(null)}
                className={menuItemClass}
              >
                <Icon name="help" className="size-4 text-ink-faint" />
                <span className="flex-1">Help</span>
                <Icon name="external" className="size-3 text-ink-faint" />
              </a>
              {feedbackOn ? (
                <MenuItem
                  icon="chat"
                  testId="menu-feedback"
                  onSelect={go(() => void openFeedback(navigate, window.location.pathname))}
                >
                  Send feedback
                </MenuItem>
              ) : null}
              <MenuDivider />
              <Versions onOpen={go(() => navigate('/settings/whats-new'))} />
            </div>
          </PhotoPicker.Provider>
        </Menu>
      ) : null}
    </>
  )
}

/** On a Mac, in a browser: the one place the Mac app is worth offering. */
function offerMacApp(): boolean {
  if (installedMacAppVersion()) return false
  const ua = navigator.userAgent
  // iPadOS calls itself a Mac; a "Mac" with a touch screen is an iPad (lib/install.ts).
  return /Macintosh/.test(ua) && !/iPhone|iPad|iPod/.test(ua) && !(navigator.maxTouchPoints > 1)
}

/** The pepper, greeting the member by name. */
function RailMascot() {
  return <Mascot name={useSession().me?.principal.name} />
}

function MenuDivider() {
  return <div aria-hidden="true" className="my-1 h-px bg-ash/70" />
}

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'Auto', icon: 'laptop' },
]

/**
 * Light, dark or the system's, changed at once and kept in this browser like the choice in
 * Settings. A theme of the member's own shows as the one in use, with none of the three picked.
 */
function ThemeSwitch({ onMore }: { onMore: () => void }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => currentTheme())
  const own = customIdOf(choice) !== null
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      {/* biome-ignore lint/a11y/useSemanticElements: choices inside a menu are menuitemradios */}
      <div
        role="group"
        aria-label="Theme"
        data-testid="menu-theme"
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-paper-sunk p-0.5"
      >
        {THEMES.map((theme) => {
          const on = choice === theme.value
          return (
            <button
              key={theme.value}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              data-testid={`menu-theme-${theme.value}`}
              title={theme.value === 'system' ? 'Follows your computer' : undefined}
              onClick={() => {
                chooseTheme(theme.value)
                setChoice(theme.value)
              }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none ${
                on ? 'bg-paper-raised text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
              }`}
            >
              <Icon name={theme.icon} className="size-3.5" />
              {theme.label}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 flex items-center justify-between px-1 text-xs text-ink-faint">
        <span data-testid="menu-theme-own">{own ? 'Using a theme of your own' : ''}</span>
        <button
          type="button"
          role="menuitem"
          data-testid="menu-theme-more"
          onClick={onMore}
          className="rounded underline decoration-ash-strong underline-offset-2 hover:text-ink focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        >
          More themes
        </button>
      </p>
    </div>
  )
}

/** Music in the menu: the row says what it is doing, and opens the controls under itself. */
function MusicMenuRow() {
  const s = useMusic()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid="menu-music"
        data-playing={s.playing ? '' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={menuItemClass}
      >
        <Icon name="music" className="size-4 text-ink-faint" />
        <span className="flex-1">Music</span>
        <span className="text-xs text-ink-faint">{musicStatus(s)}</span>
        <Icon
          name="chevron"
          className={`size-3 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        <div className="px-2.5 pt-1.5 pb-2.5">
          <MusicPanel autoFocus />
        </div>
      ) : null}
    </>
  )
}

/** The versions at the foot of the menu: this Hotsauce and, inside the Mac app, the app's own. */
function Versions({ onOpen }: { onOpen: () => void }) {
  const health = useRouteLoaderData('root') as Health | undefined
  const mac = installedMacAppVersion()
  if (!health?.version && !mac) return null
  return (
    <button
      type="button"
      role="menuitem"
      data-testid="menu-versions"
      title="See what’s new"
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs text-ink-faint hover:bg-ember-wash hover:text-ink-soft focus-visible:bg-ember-wash"
    >
      {health?.version ? (
        <span data-testid="menu-version">
          {product()} <span className="font-mono">{health.version}</span>
        </span>
      ) : null}
      {mac ? (
        <span data-testid="menu-mac-version">
          Mac app <span className="font-mono">{macVersionLabel(mac)}</span>
        </span>
      ) : null}
    </button>
  )
}

/**
 * Who's signed in, at the top of the account menu and of the phone's Apps sheet. With `face`, their
 * photo beside their name: clicking it picks a new one, and Remove photo brings the initials back
 * (docs/PLAN-rail-account-menu.md, requirements 12 and 13).
 */
export function AccountHeader({
  name,
  email,
  face = false,
}: {
  name: string | undefined
  email: string | undefined
  /** With the member's face beside their name, which they can change (the desktop menu). */
  face?: boolean
}): ReactNode {
  return (
    <div className="mb-1 flex max-w-72 items-center gap-2.5 border-b border-ash/70 px-2.5 pt-1.5 pb-2">
      {face ? <FaceButton name={name} email={email} /> : null}
      <div className="min-w-0">
        {name ? <p className="truncate text-sm font-medium text-ink">{name}</p> : null}
        <p data-testid="account-email" className="truncate text-xs text-ink-faint" title={email}>
          {email ?? ' '}
        </p>
        {face ? <PhotoLinks /> : null}
      </div>
    </div>
  )
}

/** The picker the account menu shares between the face, its links and its error line. */
const PhotoPicker = createContext<ReturnType<typeof usePhotoPicker> | null>(null)

function FaceButton({ name, email }: { name: string | undefined; email: string | undefined }) {
  const session = useSession()
  const photos = useContext(PhotoPicker)
  const has = Boolean(session.me?.photo)
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-extra=""
      data-testid="photo-change"
      aria-label={has ? 'Change your photo' : 'Add a photo of yourself'}
      title={has ? 'Change your photo' : 'Add a photo of yourself'}
      disabled={!photos || photos.busy}
      onClick={() => photos?.choose()}
      className="group relative shrink-0 rounded-full focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-60"
    >
      <MemberFace name={name} email={email} photo={session.me?.photo} className="size-9 text-xs" />
      <span
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center rounded-full bg-ink/55 text-paper-raised opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Icon name="image" className="size-4" />
      </span>
    </button>
  )
}

function PhotoLinks() {
  const session = useSession()
  const photos = useContext(PhotoPicker)
  if (!photos) return null
  const link =
    'rounded text-xs text-ink-faint underline decoration-ash-strong underline-offset-2 hover:text-ink focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-60'
  return (
    <p className="mt-0.5 flex items-center gap-2.5">
      <button
        type="button"
        role="menuitem"
        data-menu-extra=""
        data-testid="photo-add"
        disabled={photos.busy}
        onClick={photos.choose}
        className={link}
      >
        {photos.busy ? 'Saving…' : session.me?.photo ? 'Change photo' : 'Add a photo'}
      </button>
      {session.me?.photo && !photos.busy ? (
        <button
          type="button"
          role="menuitem"
          data-menu-extra=""
          data-testid="photo-remove"
          onClick={() => void photos.remove()}
          className={link}
        >
          Remove
        </button>
      ) : null}
    </p>
  )
}

/** A link that leaves the app (the team chat): greyed out offline, where it can't open. */
function ExternalRailItem({
  common,
  tips,
  href,
  name,
  body,
}: {
  common: { 'aria-label': string; 'data-testid': string; className: string }
  tips: Partial<TipHandlers>
  href: string
  name: string
  body: ReactNode
}) {
  const online = useOnline()
  if (!online) {
    return (
      <span
        data-testid={common['data-testid']}
        data-offline=""
        title={`${name}: ${NEEDS_CONNECTION}`}
        className={`${common.className} opacity-50`}
      >
        <span className="sr-only">{`${name}: ${NEEDS_CONNECTION}`}</span>
        <span aria-hidden="true" className="contents">
          {body}
        </span>
      </span>
    )
  }
  return (
    <a {...common} {...tips} href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  )
}
