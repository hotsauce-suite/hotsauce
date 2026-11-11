// What the app chrome needs to know about the meeting being recorded: a tiny store, apart
// from the controller, so the indicator and the tab title don't pull audio code into the
// entry chunk. The transcript is not here; it changes every second and only the live page
// shows it.

import { useSyncExternalStore } from 'react'
import type { MeetingState, Track } from '../../../api/types'
import type { LinkStatus } from '../audio/socket'

export interface LiveSnapshot {
  id: string
  title: string
  startedAt: string
  state: MeetingState
  link: LinkStatus
  /** This page is capturing audio. False after a reload until capture is resumed. */
  capturing: boolean
  /** A track that ended on its own (the Meet tab share was stopped). */
  lostTrack: Track | null
  error: string | null
}

let snapshot: LiveSnapshot | null = null
const listeners = new Set<() => void>()

export function getLive(): LiveSnapshot | null {
  return snapshot
}

export function setLive(next: LiveSnapshot | null): void {
  snapshot = next
  for (const listener of listeners) listener()
}

export function patchLive(patch: Partial<LiveSnapshot>): void {
  if (snapshot) setLive({ ...snapshot, ...patch })
}

export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLive(): LiveSnapshot | null {
  return useSyncExternalStore(subscribeLive, getLive)
}

/** "● Recording · Acme sync" while recording, "Paused · Acme sync" while paused. */
export function recordingTitle(live: Pick<LiveSnapshot, 'state' | 'title'>): string | null {
  if (live.state === 'recording') return `● Recording · ${live.title}`
  if (live.state === 'paused') return `Paused · ${live.title}`
  return null
}
