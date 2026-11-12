import { createContext, useContext } from 'react'
import type { AuthMode } from '../api/types'

export interface AuthState {
  mode: AuthMode
  status: 'loading' | 'signed-in' | 'signed-out'
  signOut: () => void
  /** Dev mode only: the server trusts the email header, after its domain check. */
  signInWithEmail?: (email: string) => Promise<void>
  /** Signs in with a one-time ticket from `POST /api/desktop/ticket` (the Mac app's window). */
  signInWithTicket?: (ticket: string) => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuthState(): AuthState {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuthState outside an auth provider')
  return auth
}
