// Clerk mode, loaded only when the server reports `authMode: 'clerk'` so dev builds never
// download the SDK. Google is the only sign-in method; the server enforces the domain lock.
//
// @clerk/react v6 moved the redirect-based `signIn.authenticateWithRedirect` to the
// `/legacy` entry (the root `useSignIn` is the new signal API). It is still the documented
// pairing for <AuthenticateWithRedirectCallback />, which is what we render at /sso-callback.

import { AuthenticateWithRedirectCallback, ClerkFailed, ClerkProvider, useAuth } from '@clerk/react'
import { useSignIn } from '@clerk/react/legacy'
import { type ReactNode, useMemo, useState } from 'react'
import { useNavigate, useRouteLoaderData } from 'react-router'
import { setAuthHeaders } from '../api/client'
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
  // getToken refreshes the short-lived session token as needed; ask on every request.
  setAuthHeaders(async (): Promise<Record<string, string>> => {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  })
  const value = useMemo<AuthState>(
    () => ({
      mode: 'clerk',
      status: !isLoaded ? 'loading' : isSignedIn ? 'signed-in' : 'signed-out',
      signOut: () => void signOut(),
    }),
    [isLoaded, isSignedIn, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function ClerkSignInButton() {
  const { isLoaded, signIn } = useSignIn()
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!isLoaded) return
    setError(null)
    try {
      await signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/sso-callback',
        redirectUrlComplete: '/docs',
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

export function ClerkSsoCallback() {
  return <AuthenticateWithRedirectCallback />
}
