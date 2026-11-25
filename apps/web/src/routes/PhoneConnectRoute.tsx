import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api } from '../api/client'
import { dictationApi } from '../api/dictation'
import { useAuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { isPhoneState, phoneCallback, phoneDeclined } from '../lib/phone'
import { DesktopPage } from './DesktopPage'

/**
 * Opened by the Android app in its Chrome shell after sign-in: allow this phone's home-screen
 * widgets to show your Hotsauce (docs/PLAN-android.md R5). A click is required, so a link from
 * anywhere else connects nothing; the app takes the token only with the nonce it sent.
 */
export default function PhoneConnectRoute() {
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
  if (!isPhoneState(state)) {
    return (
      <DesktopPage title="Connect your phone">
        <p className="text-ink-soft">
          This link didn’t come from the app. Open {product()} on your Android phone to connect its
          widgets.
        </p>
      </DesktopPage>
    )
  }
  if (auth.status === 'signed-out') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />
  }

  const allow = async () => {
    setPhase('working')
    setError(null)
    try {
      const { token } = await dictationApi.connectPhone('Android phone')
      const callback = phoneCallback(state, token)
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
      <DesktopPage title="Phone connected">
        <p className="text-ink-soft">
          Your widgets will fill in shortly. Long-press your home screen, tap Widgets and find{' '}
          {product()} to add one.
        </p>
        {link ? (
          <a
            href={link}
            className="mt-6 inline-flex rounded-lg bg-ember px-4 py-2.5 font-medium text-paper-raised shadow-sm hover:bg-ember-strong"
          >
            Back to {product()}
          </a>
        ) : null}
      </DesktopPage>
    )
  }

  return (
    <DesktopPage title={`Show ${product()} on your home screen?`}>
      <p className="text-ink-soft">
        {email ? (
          <>
            Let this phone’s widgets show your next meeting, today’s tasks and the weather for{' '}
            <span className="font-medium text-ink">{email}</span>.
          </>
        ) : (
          'Let this phone’s widgets show your next meeting, today’s tasks and the weather.'
        )}
      </p>
      <button
        type="button"
        onClick={allow}
        disabled={phase === 'working'}
        className="mt-6 w-full rounded-lg bg-ember px-4 py-3 font-medium text-paper-raised shadow-sm hover:bg-ember-strong disabled:opacity-60"
      >
        {phase === 'working' ? 'Connecting…' : 'Allow'}
      </button>
      <a
        href={phoneDeclined(state)}
        className="mt-3 block w-full rounded-lg px-4 py-3 text-center font-medium text-ink-soft hover:bg-paper-sunk"
      >
        Not now
      </a>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <p className="mt-4 text-sm text-ink-faint">
        The widgets can only read this summary. You can disconnect the phone any time from the app.
      </p>
    </DesktopPage>
  )
}
