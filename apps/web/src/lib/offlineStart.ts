// Starting the app with no connection (docs/PLAN-offline.md, A2).
//
// After a normal start the device keeps the instance's public start-up facts (what /api/health
// and /api/org/brand said) and, once signed in, the member: only their id, name, email and the
// workspace name. A start that can't reach the server uses them to open the app as that member.
// Signing out forgets the member. Storage can be unavailable, so every access is best-effort.

import type { Health, Me, Principal, PublicBrand } from '../api/types'

const START_KEY = 'hotsauce.offline.start'
const MEMBER_KEY = 'hotsauce.offline.member'

export interface RememberedMember {
  userId: string
  name: string
  email: string
  workspace: string | null
}

export interface RememberedStart {
  health: Health
  brand: PublicBrand | null
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Best-effort: without it, an offline start shows the "isn't reachable" page as before.
  }
}

export function rememberStart(health: Health, brand: PublicBrand | null): void {
  const { brand: _brand, offlineStart: _offline, ...facts } = health
  write(START_KEY, { health: facts, brand })
}

export function rememberedStart(): RememberedStart | null {
  const start = read<RememberedStart>(START_KEY)
  return start && typeof start.health?.authMode === 'string' ? start : null
}

export function rememberMember(principal: Principal, workspace: string | null): void {
  const member: RememberedMember = {
    userId: principal.userId,
    name: principal.name,
    email: principal.email,
    workspace,
  }
  write(MEMBER_KEY, member)
}

export function rememberedMember(): RememberedMember | null {
  const member = read<RememberedMember>(MEMBER_KEY)
  return member && typeof member.email === 'string' && typeof member.userId === 'string'
    ? member
    : null
}

export function forgetMember(): void {
  try {
    localStorage.removeItem(MEMBER_KEY)
  } catch {
    // Nothing kept.
  }
}

/** What the app knows about the member while it can't ask the server: the Team space only. */
export function offlineMe(member: RememberedMember): Me {
  return {
    principal: {
      userId: member.userId,
      email: member.email,
      name: member.name,
      handle: member.email.split('@')[0] ?? '',
      isAdmin: false,
    },
    spaces: [{ name: 'team', kind: 'team', label: 'Team' }],
    settings: { idleCommitMs: 60_000 },
  }
}

let offlineSession = false

/** The app started offline and runs without a sign-in (auth/offlineAuth.tsx): nothing can be
 * sent until it reloads into the normal sign-in, so saves keep waiting on the device. */
export function setOfflineSession(on: boolean): void {
  offlineSession = on
}

export function inOfflineSession(): boolean {
  return offlineSession
}

const SIGN_OUT_KEY = 'hotsauce.offline.signOutPending'

/** Sign out was pressed while offline: the real session is ended as soon as sign-in loads. */
export function setSignOutPending(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGN_OUT_KEY, '1')
    else localStorage.removeItem(SIGN_OUT_KEY)
  } catch {
    // No storage: the sign-out happens only on this page.
  }
}

export function signOutPending(): boolean {
  try {
    return localStorage.getItem(SIGN_OUT_KEY) === '1'
  } catch {
    return false
  }
}
