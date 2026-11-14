import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Outlet, useLoaderData, useLocation, useRouteError } from 'react-router'
import type { Health } from '../api/types'
import { BOOT_RETRY_KEY, ServerUnreachable } from '../brand/boot'
import { product } from '../brand/product'
import { DevAuthProvider } from './devAuth'

const ClerkAuthProvider = lazy(() =>
  import('./clerkAuth').then((m) => ({ default: m.ClerkAuthProvider })),
)

/** Root route: the server's /api/health says which sign-in this deployment uses. */
export function AuthRoot() {
  const health = useLoaderData() as Health
  const location = useLocation()
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

/** Seconds before the next automatic reload: soon at first (a server restarting for an update is
 * back in seconds), then less often. */
export function bootRetryDelay(retries: number): number {
  return Math.min(30, 3 * 2 ** retries)
}

const reloadPage = () => window.location.reload()

/** The root route's error page. Only a server that didn't answer is retried by itself; any other
 * error (a page that crashed) would just crash again on every reload. */
export function BootError() {
  const error = useRouteError()
  return <BootErrorView autoRetry={error instanceof ServerUnreachable} />
}

export function BootErrorView({
  autoRetry,
  reload = reloadPage,
}: {
  autoRetry: boolean
  reload?: () => void
}) {
  // Try again by itself, so a page opened while the server was restarting comes back on its own.
  useEffect(() => {
    if (!autoRetry) return
    let retries = 0
    try {
      retries = Number(sessionStorage.getItem(BOOT_RETRY_KEY) ?? 0)
      sessionStorage.setItem(BOOT_RETRY_KEY, String(retries + 1))
    } catch {
      // No sessionStorage: retry at the first delay each time.
    }
    const timer = window.setTimeout(reload, bootRetryDelay(retries) * 1000)
    return () => window.clearTimeout(timer)
  }, [autoRetry, reload])
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {autoRetry ? `${product()} isn’t reachable` : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-ink-soft">
          {autoRetry
            ? `The ${product()} server didn’t answer. Trying again by itself; you can also reload.`
            : `Something went wrong loading ${product()}. Reload to try again.`}
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
