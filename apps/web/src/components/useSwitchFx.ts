import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getLive } from '../apps/meetings/live/liveState'
import {
  drawRipple,
  playTick,
  readSwitchFx,
  type SwitchFxPrefs,
  subscribeSwitchFx,
  switchEffects,
  unlockAudio,
} from '../lib/switchFx'
import { music } from '../music/player'

/** A click this recent is what opened the new tool, so the ripple starts there. */
const CLICK_FRESH_MS = 1000

let cached: SwitchFxPrefs | null = null
function snapshot(): SwitchFxPrefs {
  cached ??= readSwitchFx()
  return cached
}
function subscribe(listener: () => void): () => void {
  return subscribeSwitchFx(() => {
    cached = null
    listener()
  })
}

/** The member's switch-ripple choices, live (Settings → Appearance). */
export function useSwitchFxPrefs(): SwitchFxPrefs {
  return useSyncExternalStore(subscribe, snapshot)
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function recording(): boolean {
  const live = getLive()
  if (live && (live.state === 'recording' || live.state === 'paused')) return true
  try {
    return music().getState().held
  } catch {
    return false
  }
}

/** Where the ripple starts when no fresh click opened the tool: that tool's icon on the rail. */
function iconCentre(appId: string): { x: number; y: number } | null {
  const el = document.querySelector<HTMLElement>(`[data-testid="app-switch-${appId}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/**
 * Plays the tool-switch ripple (and tick, if on) whenever the open tool changes
 * (docs/PLAN-switch-ripple.md). Not on the first page shown, and not when moving within a tool.
 */
export function useSwitchFx(activeApp: string | null): void {
  const previous = useRef<string | null | undefined>(undefined)
  const lastClick = useRef<{ x: number; y: number; at: number } | null>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      lastClick.current = { x: e.clientX, y: e.clientY, at: Date.now() }
      if (readSwitchFx().sound) unlockAudio()
    }
    // A key press (⌘K, a g shortcut) switches from the keyboard: the ripple starts at the icon.
    const onKey = () => {
      lastClick.current = null
      if (readSwitchFx().sound) unlockAudio()
    }
    document.addEventListener('pointerdown', onDown, { capture: true, passive: true })
    document.addEventListener('keydown', onKey, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true })
      document.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [])

  useEffect(() => {
    // Settings and Feedback belong to no tool: coming back to the same tool from them is no switch.
    if (activeApp === null) return
    const before = previous.current
    previous.current = activeApp
    if (before === undefined || before === activeApp) return
    const fx = switchEffects(readSwitchFx(), {
      reducedMotion: reducedMotion(),
      recording: recording(),
    })
    if (fx.sound) playTick()
    if (!fx.ripple) return
    const click = lastClick.current
    const origin = click && Date.now() - click.at < CLICK_FRESH_MS ? click : iconCentre(activeApp)
    lastClick.current = null
    if (origin) drawRipple(origin.x, origin.y)
  }, [activeApp])
}
