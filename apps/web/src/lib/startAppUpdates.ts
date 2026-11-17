// Wires UpdateWatch (lib/appUpdate) to the page: when to ask the server, and the moments a
// waiting update may reload (docs/PLAN-reload-after-updates.md R2, R3).

import { getLive } from '../apps/meetings/live/liveState'
import {
  AFTER_NAVIGATE_MS,
  BUILD_VERSION,
  CHECK_EVERY_MS,
  fetchNewWorker,
  IDLE_AFTER_MS,
  UpdateWatch,
} from './appUpdate'
import { reloadBlocker } from './safeToReload'

/** The router's subscribe, narrowed to what's watched: the page's path. */
type Subscribe = (
  listener: (state: { location: { pathname: string }; navigation: { state: string } }) => void,
) => unknown

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

async function askServer(): Promise<string | null> {
  const res = await fetch('/api/health', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { version?: unknown }
  return typeof body.version === 'string' && body.version ? body.version : null
}

export function startAppUpdates(subscribe: Subscribe, initialPath: string): UpdateWatch | null {
  if (!BUILD_VERSION) return null
  const watch = new UpdateWatch({
    buildVersion: BUILD_VERSION,
    serverVersion: askServer,
    blocker: () => reloadBlocker({ recordingMeeting: getLive() !== null }),
    prepare: () => fetchNewWorker(navigator.serviceWorker),
    reload: () => window.location.reload(),
    storage: sessionStore(),
    now: () => Date.now(),
  })
  const visible = () => document.visibilityState === 'visible'

  // When to ask: now and then while visible, on coming back to the front, on reconnecting.
  setTimeout(() => void watch.check(), 5_000)
  setInterval(() => visible() && void watch.check(), CHECK_EVERY_MS)
  document.addEventListener('visibilitychange', () => {
    if (visible()) void watch.check()
    else void watch.moment('hidden')
  })
  window.addEventListener('online', () => void watch.check())

  // Idle: nobody typed, clicked or scrolled for a while.
  let lastInput = Date.now()
  const touched = () => {
    lastInput = Date.now()
  }
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const)
    window.addEventListener(type, touched, { capture: true, passive: true })
  setInterval(() => {
    if (visible() && Date.now() - lastInput >= IDLE_AFTER_MS) void watch.moment('idle')
  }, 30_000)

  // Moving to another page: once it has settled, so the last page's saves have gone out.
  let path = initialPath
  subscribe((state) => {
    if (state.navigation.state !== 'idle' || state.location.pathname === path) return
    path = state.location.pathname
    setTimeout(() => void watch.moment('navigate'), AFTER_NAVIGATE_MS)
  })
  return watch
}
