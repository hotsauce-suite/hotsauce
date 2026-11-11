import { lazy, Suspense } from 'react'
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

export function BootError() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {product()} isn’t reachable
        </h1>
        <p className="mt-2 text-ink-soft">
          The {product()} server didn’t answer. Check your connection, then reload.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-ember px-4 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
