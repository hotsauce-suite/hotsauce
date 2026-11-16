// Whether the app can reach its server right now (docs/PLAN-offline.md, A3).
//
// Offline when the browser says so, or when a request to the server failed to connect. Back
// online once the browser is online and the server answers again: while it's unreachable, a
// small /api/health check runs every few seconds to notice.

import { useSyncExternalStore } from 'react'

const PROBE_MS = 5_000

type Listener = () => void

let serverUnreachable = false
/** The browser's own answer, kept from its events (navigator.onLine has already moved by then). */
let browser: boolean | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let started = false
const changed = new Set<Listener>()
const backOnline = new Set<Listener>()

const defaultProbe = async (): Promise<boolean> => {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}
let probe: () => Promise<boolean> = defaultProbe

function browserOnline(): boolean {
  if (browser === null) browser = typeof navigator === 'undefined' || navigator.onLine !== false
  return browser
}

export function isOnline(): boolean {
  start()
  return browserOnline() && !serverUnreachable
}

/** Runs `change` and tells listeners when the answer to isOnline() moved. */
function update(change: () => void): void {
  const before = isOnline()
  change()
  const after = isOnline()
  if (before === after) return
  for (const listener of changed) listener()
  if (after) for (const listener of backOnline) listener()
}

function scheduleProbe(): void {
  if (probeTimer || !serverUnreachable || !browserOnline()) return
  probeTimer = setTimeout(() => {
    probeTimer = null
    void probe().then((ok) => (ok ? reportReachable() : scheduleProbe()))
  }, PROBE_MS)
}

/** A request to the server failed to connect (not an error answer: no answer at all). */
export function reportUnreachable(): void {
  start()
  update(() => {
    serverUnreachable = true
  })
  scheduleProbe()
}

/** The server answered something. */
export function reportReachable(): void {
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
  update(() => {
    serverUnreachable = false
  })
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  browserOnline()
  window.addEventListener('offline', () =>
    update(() => {
      browser = false
    }),
  )
  // The browser has a network again; the server may not answer yet, so check before saying so.
  window.addEventListener('online', () => {
    browser = true
    serverUnreachable = true
    void probe().then((ok) => {
      if (ok) reportReachable()
      else reportUnreachable()
    })
  })
}

export function onConnectionChange(listener: Listener): () => void {
  start()
  changed.add(listener)
  return () => changed.delete(listener)
}

/** Fires each time the app goes from offline to online. */
export function onBackOnline(listener: Listener): () => void {
  start()
  backOnline.add(listener)
  return () => backOnline.delete(listener)
}

export function useOnline(): boolean {
  return useSyncExternalStore(onConnectionChange, isOnline, () => true)
}

/** Tests: swap the server check and forget the state. */
export function resetConnectionForTests(next: () => Promise<boolean> = defaultProbe): void {
  probe = next
  serverUnreachable = false
  browser = null
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
}
