// Installing the app to a phone's home screen (docs/PLAN-install-and-settings.md). Chromium
// browsers fire `beforeinstallprompt` once, often before any component mounts, so this module
// catches it as soon as it loads and keeps it for whoever asks later.

import { useSyncExternalStore } from 'react'

/** Chromium's install event; not in the DOM types. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installedNow = false
const listeners = new Set<() => void>()
/** Bumped on every change, so React re-reads the state. */
let version = 0
const notify = () => {
  version++
  for (const listener of listeners) listener()
}

/** Starts listening; runs once on import. Exported for tests, which reset it between cases. */
export function listenForInstallPrompt(target: Window = window): () => void {
  const onPrompt = (event: Event) => {
    // Keep the browser's mini bar away; we offer install ourselves.
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    notify()
  }
  const onInstalled = () => {
    deferred = null
    installedNow = true
    notify()
  }
  target.addEventListener('beforeinstallprompt', onPrompt)
  target.addEventListener('appinstalled', onInstalled)
  return () => {
    target.removeEventListener('beforeinstallprompt', onPrompt)
    target.removeEventListener('appinstalled', onInstalled)
  }
}

/** Forgets a caught prompt and an install (tests only). */
export function resetInstallPrompt(): void {
  deferred = null
  installedNow = false
  notify()
}

if (typeof window !== 'undefined') listenForInstallPrompt()

const PHONE_UA = /Android|iPhone|iPad|iPod|Mobile/i

export interface InstallContext {
  /** A phone or tablet: a finger is the main pointer on a narrow screen, or the browser says so. */
  isMobile: boolean
  /** iPhone or iPad, where only Safari's Share menu installs. */
  isIOS: boolean
  /** Running as the installed app rather than in a browser tab. */
  isInstalled: boolean
}

const matches = (query: string) =>
  typeof window.matchMedia === 'function' && window.matchMedia(query).matches

export function installContext(): InstallContext {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
  const isIOS =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const touchNarrow = matches('(pointer: coarse)') && matches('(max-width: 1024px)')
  const standalone =
    matches('(display-mode: standalone)') ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    isMobile: isIOS || touchNarrow || PHONE_UA.test(ua),
    isIOS,
    isInstalled: standalone || installedNow,
  }
}

export interface InstallPrompt extends InstallContext {
  /** The browser's own install dialog is available. */
  canPrompt: boolean
  /** Shows that dialog; 'unavailable' when there is none. */
  prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'>
}

async function prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred
  if (!event) return 'unavailable'
  // A prompt can be shown once.
  deferred = null
  notify()
  await event.prompt()
  const { outcome } = await event.userChoice
  if (outcome === 'accepted') {
    installedNow = true
    notify()
  }
  return outcome
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useInstallPrompt(): InstallPrompt {
  useSyncExternalStore(subscribe, () => version)
  return { ...installContext(), canPrompt: deferred !== null, prompt }
}

const DISMISSED_KEY = 'hotsauce:install-bar-dismissed'

export function installBarDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissInstallBar(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // Private mode: the bar still goes for this visit.
  }
}
