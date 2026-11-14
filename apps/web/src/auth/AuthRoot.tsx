import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Outlet, useLoaderData, useLocation } from 'react-router'
import type { Health } from '../api/types'
import { product } from '../brand/product'
import { DevAuthProvider } from './devAuth'

const ClerkAuthProvider = lazy(() =>
  import('./clerkAuth').then((m) => ({ default: m.ClerkAuthProvider })),
)

/** Root route: the server's /api/health says which sign-in this deployment uses. */
export function AuthRoot() {
  const health = useLoaderData() as Health
  const location = useLocation()
  // The server answered: the next outage starts its retries soon again.
  useEffect(() => {
    try {
      sessionStorage.removeItem(RETRY_KEY)
    } catch {
      // No sessionStorage: nothing to reset.
    }
  }, [])
  // A fresh instance: nobody can sign in yet, so everything leads to the setup wizard.
  if (health.authMode === 'setup' || health.setupRequired) {
    if (location.pathname !== '/setup') {
      return <Navigate to={{ pathname: '/setup', hash: location.hash }} replace />
    }
    return <Outlet />
  }
  if (health.authMode === 'clerk') {
    return (
      <Suspense fallback={null}>
        <ClerkAuthProvider>
          <Outlet />
        </ClerkAuthProvider>
      </Suspense>
    )
  }
  return (
    <DevAuthProvider>
      <Outlet />
    </DevAuthProvider>
  )
}

const RETRY_KEY = 'hearth:boot-retries'

/** Seconds before the next automatic reload: soon at first (a server restarting for an update is
 * back in seconds), then less often. */
export function bootRetryDelay(retries: number): number {
  return Math.min(30, 3 * 2 ** retries)
}

const reloadPage = () => window.location.reload()

export function BootError({ reload = reloadPage }: { reload?: () => void }) {
  // Try again by itself, so a page opened while the server was restarting comes back on its own.
  useEffect(() => {
    let retries = 0
    try {
      retries = Number(sessionStorage.getItem(RETRY_KEY) ?? 0)
      sessionStorage.setItem(RETRY_KEY, String(retries + 1))
    } catch {
      // No sessionStorage: retry at the first delay each time.
    }
    const timer = window.setTimeout(reload, bootRetryDelay(retries) * 1000)
    return () => window.clearTimeout(timer)
  }, [reload])
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {product()} isn’t reachable
        </h1>
        <p className="mt-2 text-ink-soft">
          The {product()} server didn’t answer. Trying again by itself; you can also reload.
        </p>
        <button
          type="button"
          onClick={reload}
          className="mt-5 rounded-lg bg-ember px-4 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
