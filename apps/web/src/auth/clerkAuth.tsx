// Clerk mode, loaded only when the server reports `authMode: 'clerk'` so dev builds never
// download the SDK. Members sign in with Google; people invited from outside the allowed domains
// sign in with a code emailed to them. The server enforces who may sign in either way.
//
// @clerk/react v6 moved the redirect-based `signIn.authenticateWithRedirect` to the
// `/legacy` entry (the root `useSignIn` is the new signal API). It is still the documented
// pairing for <AuthenticateWithRedirectCallback />, which is what we render at /sso-callback.

import { AuthenticateWithRedirectCallback, ClerkFailed, ClerkProvider, useAuth } from '@clerk/react'
import { isClerkAPIResponseError } from '@clerk/react/errors'
import { useSignIn, useSignUp } from '@clerk/react/legacy'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate, useRouteLoaderData } from 'react-router'
import { setAuthHeaders, setUnauthorizedHandler } from '../api/client'
import type { Health } from '../api/types'
import { AuthContext, type AuthState } from './AuthContext'

// A key baked into the build wins (VITE_CLERK_PUBLISHABLE_KEY); otherwise the server says which
// Clerk instance to use, as saved in the setup wizard.
const BUILD_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const health = useRouteLoaderData('root') as Health | undefined
  const PUBLISHABLE_KEY = BUILD_KEY || health?.clerkPublishableKey
  if (!PUBLISHABLE_KEY) {
    return (
      <p role="alert" className="p-8 text-ink">
        Sign-in isn’t configured: an admin needs to add the Clerk publishable key.
      </p>
    )
  }
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      afterSignOutUrl="/sign-in"
    >
      <ClerkBridge>{children}</ClerkBridge>
    </ClerkProvider>
  )
}

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth()
  const { signIn, setActive } = useSignIn()
  // getToken refreshes the short-lived session token as needed; ask on every request.
  setAuthHeaders(async (): Promise<Record<string, string>> => {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  })
  // Clerk says signed in but the server refuses the session (it expired, or it belongs to another
  // address of this site): sign out, which lands on the sign-in page, instead of showing errors.
  useEffect(() => {
    if (!isSignedIn) return
    let done = false
    setUnauthorizedHandler(() => {
      if (done) return
      done = true
      void signOut()
    })
    return () => setUnauthorizedHandler(null)
  }, [isSignedIn, signOut])
  const value = useMemo<AuthState>(
    () => ({
      mode: 'clerk',
      status: !isLoaded ? 'loading' : isSignedIn ? 'signed-in' : 'signed-out',
      signOut: () => void signOut(),
      signInWithTicket: async (ticket: string) => {
        if (!signIn || !setActive) throw new Error('Sign-in is still loading. Try again.')
        const attempt = await signIn.create({ strategy: 'ticket', ticket })
        if (attempt.status !== 'complete' || !attempt.createdSessionId) {
          throw new Error('That sign-in didn’t complete. Try again from the app.')
        }
        await setActive({ session: attempt.createdSessionId })
      },
    }),
    [isLoaded, isSignedIn, signOut, signIn, setActive],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function ClerkSignInButton({ returnTo = '/today' }: { returnTo?: string }) {
  const { isLoaded, signIn } = useSignIn()
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!isLoaded) return
    setError(null)
    try {
      await signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/sso-callback',
        // Back where the member was going (the Mac app's confirm page, a doc), on this site only.
        redirectUrlComplete: returnTo,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in didn’t start. Try again.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={start}
        disabled={!isLoaded}
        className="flex items-center justify-center gap-3 rounded-lg border border-ash-strong bg-paper-raised px-4 py-3 font-medium text-ink shadow-sm hover:border-ember disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 18 18" className="size-[18px]">
          <path
            fill="#EA4335"
            d="M9 3.6c1.3 0 2.4.5 3.3 1.3l2.4-2.4C13.2 1.1 11.3.3 9 .3 5.5.3 2.5 2.3 1.1 5.2l2.8 2.2C4.6 5.2 6.6 3.6 9 3.6z"
          />
          <path
            fill="#4285F4"
            d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8c-.2 1.1-.8 2-1.8 2.7l2.7 2.1c1.6-1.5 2.9-3.7 2.9-6.4z"
          />
          <path
            fill="#FBBC05"
            d="M3.9 10.6c-.2-.5-.3-1-.3-1.6s.1-1.1.3-1.6L1.1 5.2C.5 6.3.2 7.6.2 9s.3 2.7.9 3.8l2.8-2.2z"
          />
          <path
            fill="#34A853"
            d="M9 17.7c2.4 0 4.4-.8 5.8-2.1l-2.7-2.1c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8l-2.8 2.2c1.4 2.9 4.4 4.9 7.9 4.9z"
          />
        </svg>
        Continue with Google
      </button>
      <ClerkFailed>
        <p role="alert" className="text-sm text-ember-strong">
          Sign-in didn’t load. Check your connection, then reload the page.
        </p>
      </ClerkFailed>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}

type CodeStep = { kind: 'email' } | { kind: 'code'; flow: 'sign-in' | 'sign-up' }

/** Clerk's own message for an API error, else a plain fallback. */
function clerkMessage(err: unknown, fallback: string): string {
  if (isClerkAPIResponseError(err)) {
    const first = err.errors[0]
    return first?.longMessage || first?.message || fallback
  }
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * For people invited from outside the allowed domains: type an email, get a code, type it back.
 * Someone Clerk hasn't seen is signed up instead of in; the server decides whether they may stay.
 */
export function ClerkEmailCodeSignIn({ returnTo = '/today' }: { returnTo?: string }) {
  const navigate = useNavigate()
  const signInState = useSignIn()
  const signUpState = useSignUp()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<CodeStep>({ kind: 'email' })
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button
        type="button"
        data-testid="email-code-open"
        onClick={() => setOpen(true)}
        className="text-sm text-ink-soft underline decoration-ash-strong underline-offset-4 hover:text-ink"
      >
        Invited from outside? Sign in with an email code
      </button>
    )
  }

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(clerkMessage(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = () =>
    run(async () => {
      const { signIn } = signInState
      const { signUp } = signUpState
      if (!signInState.isLoaded || !signUpState.isLoaded || !signIn || !signUp) {
        throw new Error('Sign-in is still loading. Try again.')
      }
      const address = email.trim()
      try {
        const attempt = await signIn.create({ identifier: address })
        const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === 'email_code')
        if (!factor || !('emailAddressId' in factor)) {
          throw new Error('Email codes aren’t turned on for this workspace yet. Ask an admin.')
        }
        await signIn.prepareFirstFactor({
          strategy: 'email_code',
          emailAddressId: factor.emailAddressId,
        })
        setStep({ kind: 'code', flow: 'sign-in' })
      } catch (err) {
        // A first visit: Clerk has no account for this address yet, so make one.
        if (
          isClerkAPIResponseError(err) &&
          err.errors.some((e) => e.code === 'form_identifier_not_found')
        ) {
          await signUp.create({ emailAddress: address })
          await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
          setStep({ kind: 'code', flow: 'sign-up' })
          return
        }
        throw err
      }
    }, 'Couldn’t send a code. Check the address and try again.')

  const verify = () =>
    run(async () => {
      if (step.kind !== 'code') return
      const typed = code.trim()
      let sessionId: string | null = null
      if (step.flow === 'sign-in') {
        const { signIn, setActive } = signInState
        if (!signIn || !setActive) throw new Error('Sign-in is still loading. Try again.')
        const attempt = await signIn.attemptFirstFactor({ strategy: 'email_code', code: typed })
        if (attempt.status === 'complete') sessionId = attempt.createdSessionId
        if (sessionId) await setActive({ session: sessionId })
      } else {
        const { signUp, setActive } = signUpState
        if (!signUp || !setActive) throw new Error('Sign-in is still loading. Try again.')
        const attempt = await signUp.attemptEmailAddressVerification({ code: typed })
        if (attempt.status === 'complete') sessionId = attempt.createdSessionId
        if (sessionId) await setActive({ session: sessionId })
      }
      if (!sessionId) throw new Error('That sign-in didn’t complete. Ask an admin for help.')
      navigate(returnTo, { replace: true })
    }, 'That code didn’t work. Check it and try again.')

  const inputClass =
    'h-11 rounded-lg border border-ash-strong bg-paper-raised px-3.5 text-ink outline-none placeholder:text-ink-faint focus:border-ember'
  const buttonClass =
    'h-11 rounded-lg bg-ember font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60'

  return (
    <form
      data-testid="email-code-form"
      onSubmit={(event) => {
        event.preventDefault()
        void (step.kind === 'email' ? sendCode() : verify())
      }}
      className="flex flex-col gap-3"
    >
      {step.kind === 'email' ? (
        <>
          <label htmlFor="code-email" className="text-sm font-medium text-ink-soft">
            Your email
          </label>
          <input
            id="code-email"
            data-testid="email-code-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </>
      ) : (
        <>
          <label htmlFor="code-value" className="text-sm font-medium text-ink-soft">
            The code we sent to {email.trim()}
          </label>
          <input
            id="code-value"
            data-testid="email-code-value"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className={inputClass}
          />
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function ClerkSsoCallback() {
  return <AuthenticateWithRedirectCallback />
}
