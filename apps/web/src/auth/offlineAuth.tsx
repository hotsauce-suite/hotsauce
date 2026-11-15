// The app started with no connection (docs/PLAN-offline.md, A2): signed in as the last member
// this device remembers, without asking Clerk or the server. Nothing is signed, so requests that
// do get through are refused; once the server answers again the page reloads into the normal
// sign-in, and Clerk's own session takes over (or asks to sign in again if it expired). Unsent
// doc saves stay on the device across that reload and are sent after it (lib/drafts).

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { setAuthHeaders, setUnauthorizedHandler } from '../api/client'
import type { AuthMode } from '../api/types'
import { onBackOnline } from '../lib/connection'
import { forgetMember, rememberedMember } from '../lib/offlineStart'
import { AuthContext, type AuthState } from './AuthContext'

const reloadPage = () => window.location.reload()

export function OfflineAuthProvider({
  mode,
  children,
  reload = reloadPage,
}: {
  mode: AuthMode
  children: ReactNode
  reload?: () => void
}) {
  const [member, setMember] = useState(rememberedMember)
  setAuthHeaders(() => ({}))

  useEffect(() => {
    setUnauthorizedHandler(null)
    return onBackOnline(reload)
  }, [reload])

  const signOut = useCallback(() => {
    forgetMember()
    setMember(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ mode, status: member ? 'signed-in' : 'signed-out', offline: true, signOut }),
    [mode, member, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
