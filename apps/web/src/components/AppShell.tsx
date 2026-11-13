import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation, useOutletContext, useParams } from 'react-router'
import { BoardsSidebar } from '../apps/boards/BoardsSidebar'
import { BriefcastSidebar } from '../apps/briefcast/BriefcastSidebar'
import { ClipsSidebar } from '../apps/clips/ClipsSidebar'
import { DictateSidebar } from '../apps/dictate/DictateSidebar'
import { FilesSidebar } from '../apps/files/FilesSidebar'
import { RecordingIndicator } from '../apps/meetings/components/RecordingIndicator'
import { useLive } from '../apps/meetings/live/liveState'
import { useRecordingTitle } from '../apps/meetings/live/useRecordingTitle'
import { MeetingsSidebar } from '../apps/meetings/MeetingsSidebar'
import { NotesSidebar } from '../apps/notes/NotesSidebar'
import { appForPath, ownerOfPath } from '../apps/registry'
import { TasksSidebar } from '../apps/tasks/TasksSidebar'
import { useAuthState } from '../auth/AuthContext'
import { MOBILE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { formatSpec } from '../keyboard/keys'
import { ShortcutsSheet } from '../keyboard/ShortcutsSheet'
import { useKeyListener, useShortcut } from '../keyboard/shortcuts'
import { useAppShortcuts } from '../keyboard/useAppShortcuts'
import { useBuiltInCommands } from '../keyboard/useBuiltInCommands'
import { displayName } from '../lib/paths'
import { SessionProvider, useSession } from '../state/session'
import { AppRail, rememberAppLocation } from './AppRail'
import { AssistantHost } from './assistant/AssistantHost'
import { Icon } from './Icon'
import { Sidebar, SidebarFrame } from './Sidebar'

const CommandK = lazy(() => import('./CommandK'))

export interface ShellContext {
  compact: boolean
  openDrawer: () => void
  openSearch: () => void
  /** Opens the keyboard shortcuts sheet (`?`). */
  openShortcuts: () => void
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>()
}

/**
 * The signed-in frame around every app: the active app's sidebar (a drawer on phones), the
 * routed page, Cmd-K, notices, and the recording indicator while a meeting is live. One
 * layout route wraps all apps, so switching apps keeps the session and the socket.
 */
export default function AppShell() {
  const auth = useAuthState()
  const location = useLocation()
  if (auth.status === 'loading') return null
  if (auth.status === 'signed-out') {
    // The query comes along: a shared link's save page (/links/save?url=…) needs it after sign-in.
    return (
      <Navigate to="/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />
    )
  }
  return (
    <SessionProvider>
      <ShellLayout />
    </SessionProvider>
  )
}

function decodePath(splat: string | undefined): string | null {
  if (!splat) return null
  try {
    return decodeURIComponent(splat)
  } catch {
    return splat
  }
}

function ShellLayout() {
  const params = useParams()
  const location = useLocation()
  const session = useSession()
  const compact = useMediaQuery(MOBILE_QUERY)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoaded, setSearchLoaded] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const activeSpace = params.space ?? null
  const activePath = decodePath(params['*'])
  const { setSpace } = session
  const app = appForPath(location.pathname)
  const live = useLive()
  // The voice notes page shows its own recording, and what any other meeting is doing.
  const onLivePage =
    live !== null &&
    (location.pathname === `/meetings/live/${live.id}` || location.pathname === '/dictate/voice')
  useRecordingTitle(live)

  // The sidebar follows the open doc's space.
  useEffect(() => {
    if (activeSpace) setSpace(activeSpace)
  }, [activeSpace, setSpace])

  // Navigating closes the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every location change.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.key])

  useEffect(() => {
    rememberAppLocation(location.pathname, location.search)
  }, [location.pathname, location.search])

  const openSearch = useCallback(() => {
    setSearchLoaded(true)
    setSearchOpen(true)
    setDrawerOpen(false)
  }, [])

  // The one key listener for the whole app (keyboard/shortcuts.ts); pages bind to it.
  useKeyListener()

  // Cmd/Ctrl-K anywhere. The editor claims it first when text is selected (make a link),
  // and marks the event handled, so the listener leaves it alone.
  useShortcut('global.commandK', () => {
    setSearchLoaded(true)
    setSearchOpen((open) => !open)
    setShortcutsOpen(false)
    return true
  })
  useShortcut('global.help', () => {
    setShortcutsOpen(true)
    return true
  })
  useShortcut('global.sidebar', () => {
    if (compact) setDrawerOpen((open) => !open)
    else {
      // Focus inside the sidebar would drop to the page's body; it goes to the page instead.
      if (!sidebarHidden && document.activeElement?.closest('[data-sidebar-frame]'))
        document.querySelector<HTMLElement>('main')?.focus()
      setSidebarHidden((hidden) => !hidden)
    }
    return true
  })
  useAppShortcuts({ app: app.id, openSearch })
  useBuiltInCommands({ openShortcuts: () => setShortcutsOpen(true) })

  // Warm the palette's chunk while idle so the first Cmd-K opens instantly.
  useEffect(() => {
    const warm = setTimeout(() => void import('./CommandK'), 2500)
    return () => clearTimeout(warm)
  }, [])

  const context: ShellContext = {
    compact,
    openDrawer: () => setDrawerOpen(true),
    openSearch,
    openShortcuts: () => setShortcutsOpen(true),
  }

  // One frame for every app, so switching apps swaps the body without replaying the warm-up.
  const sidebar = (
    <SidebarFrame app={app}>
      {app.id === 'meetings' ? (
        <MeetingsSidebar
          activeSpace={activeSpace}
          activePath={activePath}
          onOpenSearch={openSearch}
        />
      ) : app.id === 'dictate' ? (
        <DictateSidebar />
      ) : app.id === 'clips' ? (
        <ClipsSidebar />
      ) : app.id === 'tasks' ? (
        <TasksSidebar />
      ) : app.id === 'notes' ? (
        <NotesSidebar />
      ) : app.id === 'boards' ? (
        <BoardsSidebar />
      ) : app.id === 'files' ? (
        <FilesSidebar />
      ) : app.id === 'briefcast' ? (
        <BriefcastSidebar />
      ) : (
        <Sidebar activeSpace={activeSpace} activePath={activePath} onOpenSearch={openSearch} />
      )}
    </SidebarFrame>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The first Tab stop: past the rail and sidebar to the page. */}
      <button
        type="button"
        data-testid="skip-link"
        onClick={() => document.getElementById('main')?.focus()}
        className="sr-only z-50 rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </button>
      <div className="flex min-h-0 flex-1">
        {compact ? (
          drawerOpen ? (
            <div className="fixed inset-0 z-40 flex">
              <div className="h-full w-[min(85vw,var(--sidebar-width))] shadow-float">
                {sidebar}
              </div>
              <button
                type="button"
                aria-label="Close sidebar"
                onClick={() => setDrawerOpen(false)}
                className="flex-1 bg-paper-sunk/60 backdrop-blur-[1px]"
              />
            </div>
          ) : null
        ) : (
          <>
            <AppRail orientation="vertical" />
            {app.sidebar === false ? null : sidebarHidden ? (
              // ⌘\ hid it: a slim strip brings it back for anyone without the key.
              <button
                type="button"
                data-testid="show-sidebar"
                aria-label="Show the sidebar"
                title={`Show the sidebar (${formatSpec('mod+\\').join('')})`}
                onClick={() => setSidebarHidden(false)}
                className="flex h-full w-3 shrink-0 items-center justify-center border-r border-ash/70 text-ink-faint hover:w-6 hover:bg-paper-raised focus-visible:w-6 [@media(pointer:coarse)]:w-7"
              >
                <Icon name="chevron" className="size-3" />
              </button>
            ) : (
              <div className="relative h-full w-[var(--sidebar-width)] shrink-0" data-sidebar-frame>
                {sidebar}
                {/* ⌘\ on a keyboard; this for a finger (an upright iPad wants the room). */}
                <button
                  type="button"
                  data-testid="hide-sidebar"
                  aria-label="Hide the sidebar"
                  title={`Hide the sidebar (${formatSpec('mod+\\').join('')})`}
                  onClick={() => setSidebarHidden(true)}
                  className="tap-target absolute top-3 right-2 z-10 flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-paper-raised hover:text-ink"
                >
                  <Icon name="sidebar" className="size-4" />
                </button>
              </div>
            )}
          </>
        )}

        <main
          id="main"
          tabIndex={-1}
          className="shell-main flex h-full min-w-0 flex-1 flex-col outline-none"
        >
          {live && !onLivePage ? <RecordingIndicator live={live} variant="strip" /> : null}
          <Outlet context={context} />
        </main>
      </div>

      {compact ? <AppRail orientation="horizontal" /> : null}

      <AssistantHost
        compact={compact}
        page={
          activeSpace && activePath
            ? { space: activeSpace, path: activePath, title: displayName(activePath) }
            : null
        }
      />

      {searchLoaded ? (
        <Suspense fallback={null}>
          <CommandK open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      ) : null}

      {shortcutsOpen ? (
        <ShortcutsSheet
          app={ownerOfPath(location.pathname)?.id ?? null}
          onClose={() => setShortcutsOpen(false)}
        />
      ) : null}

      <div
        aria-live="polite"
        className={`pointer-events-none fixed right-4 z-50 flex max-w-sm flex-col gap-2 ${compact ? 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))]' : 'bottom-4'}`}
      >
        {session.notices.map((notice) => (
          <div
            key={notice.id}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-ash bg-paper-raised px-3.5 py-2.5 text-sm text-ink shadow-float"
          >
            <span className="flex-1">{notice.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => session.dismiss(notice.id)}
              className="text-ink-faint hover:text-ink"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
