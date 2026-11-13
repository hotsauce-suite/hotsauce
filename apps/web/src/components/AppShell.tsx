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
import { ShortcutsSheet } from '../keyboard/ShortcutsSheet'
import { useKeyListener, useShortcut } from '../keyboard/shortcuts'
import { SessionProvider, useSession } from '../state/session'
import { AppRail, rememberAppLocation } from './AppRail'
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
            {app.sidebar === false ? null : (
              <div className="h-full w-[var(--sidebar-width)] shrink-0">{sidebar}</div>
            )}
          </>
        )}

        <main className="shell-main flex h-full min-w-0 flex-1 flex-col">
          {live && !onLivePage ? <RecordingIndicator live={live} variant="strip" /> : null}
          <Outlet context={context} />
        </main>
      </div>

      {compact ? <AppRail orientation="horizontal" /> : null}

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
