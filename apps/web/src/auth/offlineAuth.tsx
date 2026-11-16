// The app started with no connection (docs/PLAN-offline.md, A2): signed in as the last member
// this device remembers, without asking Clerk or the server. Nothing is signed, so requests that
// do get through are refused; once the server answers again the page reloads into the normal
// sign-in, and Clerk's own session takes over (or asks to sign in again if it expired). Unsent
// doc saves stay on the device across that reload and are sent after it (lib/drafts).

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { setAuthHeaders, setUnauthorizedHandler } from '../api/client'
import type { AuthMode } from '../api/types'
import { isOnline, onBackOnline } from '../lib/connection'
import {
  forgetMember,
  rememberedMember,
  setOfflineSession,
  setSignOutPending,
} from '../lib/offlineStart'
import { AuthContext, type AuthState } from './AuthContext'

const reloadPage = () => window.location.reload()
const RELOAD_KEY = 'hotsauce.offline.reloadAt'
/** At most one reconnect reload this often, so a server that flaps can't loop the page. */
export const RELOAD_GAP_MS = 10_000

/** When the next reload may run (0: now). */
function reloadWait(now: number): number {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    return Math.max(0, last + RELOAD_GAP_MS - now)
  } catch {
    return 0
  }
}

function markReload(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    // No sessionStorage: no guard, as before.
  }
}

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
  // Set during render, before any child (a doc) tries to send.
  setOfflineSession(true)

  useEffect(() => {
    setUnauthorizedHandler(null)
    let timer: ReturnType<typeof setTimeout> | null = null
    const reconnect = () => {
      if (timer) return
      const wait = reloadWait(Date.now())
      timer = setTimeout(() => {
        markReload(Date.now())
        reload()
      }, wait)
    }
    const off = onBackOnline(reconnect)
    // The server answered before this subscribed: reconnect now.
    if (isOnline()) reconnect()
    return () => {
      off()
      if (timer) clearTimeout(timer)
      setOfflineSession(false)
    }
  }, [reload])

  // The real session can't be ended offline: it's ended as soon as sign-in loads again.
  const signOut = useCallback(() => {
    setSignOutPending(true)
    forgetMember()
    setMember(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ mode, status: member ? 'signed-in' : 'signed-out', offline: true, signOut }),
    [mode, member, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
