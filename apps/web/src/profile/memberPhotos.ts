// Who has a profile photo (docs/PLAN-rail-account-menu.md, requirement 15): one list for the whole
// app, asked for once and again when the window comes back, so a face shows wherever a member is
// named. A member's own change lands here at once.

import { useSyncExternalStore } from 'react'
import { request } from '../api/client'

type PhotoMap = Readonly<Record<string, string>>

const NONE: PhotoMap = {}
let photos: PhotoMap = NONE
let asked: Promise<void> | null = null
let askedAt = 0
const listeners = new Set<() => void>()

/** How long the list is trusted before a returning window asks again. */
const FRESH_MS = 60_000

function set(next: PhotoMap): void {
  photos = next
  for (const listener of listeners) listener()
}

function ask(): void {
  if (asked) return
  askedAt = Date.now()
  asked = request<{ photos: Record<string, string> }>('/api/members/photos')
    .then(
      (res) => set(res.photos ?? NONE),
      // Offline or signed out: initials, and another try later.
      () => {
        askedAt = 0
      },
    )
    .finally(() => {
      asked = null
    })
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    if (Date.now() - askedAt > FRESH_MS) ask()
    document.addEventListener('visibilitychange', onVisible)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) document.removeEventListener('visibilitychange', onVisible)
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible' && Date.now() - askedAt > FRESH_MS) ask()
}

/** The member's own photo changed here: everyone on screen shows it without asking again. */
export function setMemberPhoto(email: string, photo: string | null): void {
  const key = email.toLowerCase()
  const next = { ...photos }
  if (photo) next[key] = photo
  else delete next[key]
  set(next)
}

/** Forgets the list (tests, and signing out). */
export function forgetMemberPhotos(): void {
  photos = NONE
  askedAt = 0
}

/** The address of this person's photo, or null: no photo, not a member, or not known yet. */
export function useMemberPhoto(email: string | null | undefined): string | null {
  const all = useSyncExternalStore(subscribe, () => photos)
  return email ? (all[email.toLowerCase()] ?? null) : null
}
