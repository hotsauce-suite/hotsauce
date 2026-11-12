import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api, setAuthHeaders, setUnauthorizedHandler } from '../api/client'
import { AuthContext, type AuthState } from './AuthContext'

// Dev auth (AUTH_MODE=dev): the server trusts `x-hearth-dev-user`. The email survives
// reloads in localStorage; the server still enforces the domain lock.

const STORAGE_KEY = 'hearth.devUser'

function readDevUser(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function persistDevUser(email: string | null): void {
  try {
    if (email) localStorage.setItem(STORAGE_KEY, email)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode: the session lasts as long as the tab.
  }
}

function signRequestsAs(email: string | null) {
  setAuthHeaders(() => (email ? { 'x-hearth-dev-user': email } : {}))
}

export function DevAuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState(readDevUser)
  // Set synchronously during render so the first API calls of children are signed.
  signRequestsAs(email)

  const signOut = useCallback(() => {
    persistDevUser(null)
    setEmail(null)
  }, [])

  /** Checks the address with the server (domain lock) before keeping it. */
  const signInWithEmail = useCallback(async (raw: string) => {
    const candidate = raw.trim().toLowerCase()
    setAuthHeaders(() => ({ 'x-hearth-dev-user': candidate }))
    try {
      await api.me()
    } catch (err) {
      setAuthHeaders(() => ({}))
      throw err
    }
    persistDevUser(candidate)
    setEmail(candidate)
  }, [])

  /** The dev server's ticket is `dev:<email>`. */
  const signInWithTicket = useCallback(
    async (ticket: string) => {
      if (!ticket.startsWith('dev:')) throw new Error('Not a development sign-in ticket')
      await signInWithEmail(ticket.slice('dev:'.length))
    },
    [signInWithEmail],
  )

  useEffect(() => {
    const onStorage = () => setEmail(readDevUser())
    window.addEventListener('storage', onStorage)
    setUnauthorizedHandler(signOut)
    return () => {
      window.removeEventListener('storage', onStorage)
      setUnauthorizedHandler(null)
    }
  }, [signOut])

  const value = useMemo<AuthState>(
    () => ({
      mode: 'dev',
      status: email ? 'signed-in' : 'signed-out',
      signOut,
      signInWithEmail,
      signInWithTicket,
    }),
    [email, signOut, signInWithEmail, signInWithTicket],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
