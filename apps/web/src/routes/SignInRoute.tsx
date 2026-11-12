import { lazy, Suspense, useState } from 'react'
import { Navigate, useLocation, useNavigate, useRouteLoaderData } from 'react-router'
import { HearthApiError } from '../api/client'
import type { Health } from '../api/types'
import { useAuthState } from '../auth/AuthContext'
import { product } from '../brand/product'
import { BrandMark } from '../components/BrandMark'
import { desktopSignInBridge, safeReturnPath } from '../lib/desktop'

const ClerkSignInButton = lazy(() =>
  import('../auth/clerkAuth').then((m) => ({ default: m.ClerkSignInButton })),
)
const ClerkEmailCodeSignIn = lazy(() =>
  import('../auth/clerkAuth').then((m) => ({ default: m.ClerkEmailCodeSignIn })),
)

export default function SignInRoute() {
  const auth = useAuthState()
  const location = useLocation()
  const from = safeReturnPath((location.state as { from?: string } | null)?.from)
  const desktop = desktopSignInBridge()
  const health = useRouteLoaderData('root') as Health | undefined
  const domain = health?.signInDomain
  if (auth.status === 'signed-in') return <Navigate to={from} replace />

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-clip p-6">
      <div
        aria-hidden="true"
        className="hearth-glow pointer-events-none absolute -bottom-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--glow) 30%, transparent), color-mix(in oklab, var(--ember) 10%, transparent) 45%, transparent 70%)',
        }}
      />
      <main className="shell-main relative w-full max-w-sm">
        <BrandMark className="size-11" />
        <h1 className="mt-5 font-display text-[2.1rem] leading-tight font-semibold tracking-tight text-ink [font-variation-settings:'opsz'_96]">
          {product()}
        </h1>
        <p className="mt-2 mb-7 text-ink-soft">
          {domain
            ? `Sign in with your ${domain} account to open the team’s workspace.`
            : 'Sign in with your work account to open the team’s workspace.'}
        </p>
        {desktop ? (
          <DesktopSignIn start={() => desktop.postMessage('start')} />
        ) : auth.mode === 'dev' ? (
          <DevSignInForm from={from} domain={domain} />
        ) : (
          <Suspense fallback={<div className="h-12" />}>
            <div className="flex flex-col gap-5">
              <ClerkSignInButton returnTo={from} />
              {health?.emailCodeSignIn ? <ClerkEmailCodeSignIn returnTo={from} /> : null}
            </div>
          </Suspense>
        )}
      </main>
    </div>
  )
}

function DevSignInForm({ from, domain }: { from: string; domain: string | null | undefined }) {
  const auth = useAuthState()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!auth.signInWithEmail) return
    setBusy(true)
    setError(null)
    try {
      await auth.signInWithEmail(email)
      navigate(from, { replace: true })
    } catch (err) {
      setError(
        err instanceof HearthApiError && err.code !== 'network'
          ? err.message
          : `Couldn’t reach the ${product()} server. Is it running?`,
      )
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="flex flex-col gap-3"
    >
      <label htmlFor="dev-email" className="text-sm font-medium text-ink-soft">
        Work email <span className="font-normal text-ink-faint">(development sign-in)</span>
      </label>
      <input
        id="dev-email"
        data-testid="dev-signin-email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={`you@${domain ?? 'example.com'}`}
        className="h-11 rounded-lg border border-ash-strong bg-paper-raised px-3.5 text-ink outline-none placeholder:text-ink-faint focus:border-ember"
      />
      <button
        type="submit"
        data-testid="dev-signin-submit"
        disabled={busy}
        className="h-11 rounded-lg bg-ember font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </form>
  )
}

/**
 * In the Mac app's window: Google won't sign in inside an app, so the app opens the member's
 * browser, where they're usually signed in already, and is handed a one-time ticket back.
 */
function DesktopSignIn({ start }: { start: () => void }) {
  const [started, setStarted] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => {
          setStarted(true)
          start()
        }}
        className="rounded-lg bg-ember px-4 py-3 font-medium text-paper-raised shadow-sm hover:bg-ember-strong"
      >
        Sign in with your browser
      </button>
      <p className="text-sm text-ink-faint">
        {started
          ? 'Finish in your browser, then come back here.'
          : 'Opens your browser. If you’re signed in to Hearth there, it’s one click.'}
      </p>
    </div>
  )
}
