import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api } from '../api/client'
import { useAuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { desktopCallback, isDesktopState } from '../lib/desktop'
import { DesktopPage } from './DesktopPage'

/**
 * Opened by the Mac app in the member's browser: confirm, and the app's window signs in with a
 * one-time ticket. A click is required, so a link from anywhere else can't sign the app in.
 */
export default function DesktopConnectRoute() {
  const auth = useAuthState()
  const location = useLocation()
  const state = new URLSearchParams(location.search).get('state')
  const [email, setEmail] = useState<string | null>(null)
  const [phase, setPhase] = useState<'confirm' | 'working' | 'done'>('confirm')
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (auth.status !== 'signed-in') return
    api
      .me()
      .then((me) => setEmail(me.principal.email))
      .catch(() => {})
  }, [auth.status])

  if (auth.status === 'loading') return null
  if (!isDesktopState(state)) {
    return (
      <DesktopPage title="Sign in to the Mac app">
        <p className="text-ink-soft">
          This link didn’t come from the app. Open {product()} on your Mac and press Sign in with
          your browser.
        </p>
      </DesktopPage>
    )
  }
  if (auth.status === 'signed-out') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />
  }

  const confirm = async () => {
    setPhase('working')
    setError(null)
    try {
      const { ticket } = await api.desktopTicket()
      const callback = desktopCallback(state, ticket)
      setLink(callback)
      setPhase('done')
      window.location.href = callback
    } catch (err) {
      setPhase('confirm')
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.')
    }
  }

  if (phase === 'done') {
    return (
      <DesktopPage title="Back to the app">
        <p className="text-ink-soft">
          {product()} is signing in on your Mac. You can close this tab.
        </p>
        {link ? (
          <a
            href={link}
            className="mt-6 inline-flex rounded-lg bg-ember px-4 py-2.5 font-medium text-paper-raised shadow-sm hover:bg-ember-strong"
          >
            Open {product()}
          </a>
        ) : null}
      </DesktopPage>
    )
  }

  return (
    <DesktopPage title="Sign in to the Mac app">
      <p className="text-ink-soft">
        {email ? (
          <>
            Sign in to {product()} on this Mac as{' '}
            <span className="font-medium text-ink">{email}</span>?
          </>
        ) : (
          `Sign in to ${product()} on this Mac with this account?`
        )}
      </p>
      <button
        type="button"
        onClick={confirm}
        disabled={phase === 'working'}
        className="mt-6 w-full rounded-lg bg-ember px-4 py-3 font-medium text-paper-raised shadow-sm hover:bg-ember-strong disabled:opacity-60"
      >
        {phase === 'working' ? 'Signing in…' : 'Sign in to the Mac app'}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <p className="mt-4 text-sm text-ink-faint">
        Didn’t start this from the {product()} app? Close this tab.
      </p>
    </DesktopPage>
  )
}
