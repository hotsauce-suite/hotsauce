import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { dictationApi } from '../api/dictation'
import { useAuthState } from '../auth/AuthContext'
import { connectDictateAfterSignIn, takeDesktopTicket } from '../lib/desktop'
import { DesktopPage } from './DesktopPage'

/**
 * In the Mac app's window: redeems the one-time ticket the browser handed the app. The ticket
 * comes from the app itself, never from this page's URL, so a link here signs nothing in.
 */
export default function DesktopFinishRoute() {
  const auth = useAuthState()
  const navigate = useNavigate()
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (auth.status !== 'signed-out' || started.current || !auth.signInWithTicket) return
    started.current = true
    const signIn = auth.signInWithTicket
    takeDesktopTicket()
      .then((ticket) => {
        if (!ticket)
          throw new Error('This page only works right after signing in from your browser.')
        return signIn(ticket)
      })
      // Signing in also connects this Mac's Dictate; if that fails, the Dictate page still can.
      .then(() => connectDictateAfterSignIn(dictationApi.connect))
      .then(() => navigate('/today', { replace: true }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Sign-in failed.'))
  }, [auth, navigate])

  // Already signed in when the page opened: nothing to do. Signed in by this page: stay until
  // Dictate is connected too (the app answers only while this page is open).
  if (auth.status === 'signed-in' && !started.current) return <Navigate to="/today" replace />
  if (!error) {
    return (
      <DesktopPage title="Signing in…">
        <p className="text-ink-soft">One moment.</p>
      </DesktopPage>
    )
  }
  return (
    <DesktopPage title="Couldn’t sign in">
      <p className="text-ink-soft">{error} Press Sign in with your browser to try again.</p>
      <a href="/sign-in" className="mt-6 inline-flex text-ember underline">
        Back to sign-in
      </a>
    </DesktopPage>
  )
}
