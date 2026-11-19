// A ripple (and, if the member turns it on, a soft tick) when they switch tools
// (docs/PLAN-switch-ripple.md). Both are chosen per browser; the ripple is skipped when the
// device asks for reduced motion, and the tick stays silent while anything is recording.

import { playWave, WAVE_MS } from './liquidWave'

export const SWITCH_FX_KEY = 'hotsauce:switch-fx'

export interface SwitchFxPrefs {
  /** A ripple spreads from the click when the member opens another tool (R1). On by default. */
  ripple: boolean
  /** A soft tick plays with it (R4). Off by default. */
  sound: boolean
}

export const DEFAULT_SWITCH_FX: SwitchFxPrefs = { ripple: true, sound: false }

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readSwitchFx(store: StorageLike | null = storage()): SwitchFxPrefs {
  try {
    const raw = store?.getItem(SWITCH_FX_KEY)
    if (!raw) return { ...DEFAULT_SWITCH_FX }
    const parsed = JSON.parse(raw) as Partial<SwitchFxPrefs>
    return {
      ripple: typeof parsed.ripple === 'boolean' ? parsed.ripple : DEFAULT_SWITCH_FX.ripple,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_SWITCH_FX.sound,
    }
  } catch {
    return { ...DEFAULT_SWITCH_FX }
  }
}

const listeners = new Set<() => void>()

export function writeSwitchFx(
  patch: Partial<SwitchFxPrefs>,
  store: StorageLike | null = storage(),
): SwitchFxPrefs {
  const next = { ...readSwitchFx(store), ...patch }
  try {
    store?.setItem(SWITCH_FX_KEY, JSON.stringify(next))
  } catch {}
  for (const listener of listeners) listener()
  return next
}

export function subscribeSwitchFx(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface FxEnv {
  /** The device asks for less motion. */
  reducedMotion: boolean
  /** A microphone, camera or screen capture is open, or a meeting is recording. */
  recording: boolean
}

/** What a tool switch plays, given the member's choices and the device (R1, R3, R4, R5). */
export function switchEffects(
  prefs: SwitchFxPrefs,
  env: FxEnv,
): { ripple: boolean; sound: boolean } {
  return {
    ripple: prefs.ripple && !env.reducedMotion,
    sound: prefs.sound && !env.recording,
  }
}

/** How long the ripple runs (R2): about as long as the wave takes to cross the window. */
export const RIPPLE_MS = WAVE_MS

/** How far the ripple must spread from (x, y) to clear every corner of the window. */
export function reachFrom(x: number, y: number, w: number, h: number): number {
  return (
    Math.max(
      Math.hypot(x, y),
      Math.hypot(w - x, y),
      Math.hypot(x, h - y),
      Math.hypot(w - x, h - y),
    ) * 1.3
  )
}

/**
 * Draws one ripple from (x, y) (R2, R7): the whole window bends like water as a wave runs out to
 * every corner, with a band of light riding its front. It sits above the page, ignores the
 * pointer and removes itself, so it never delays or blocks anything.
 */
export function drawRipple(x: number, y: number, doc: Document = document): HTMLElement | null {
  const body = doc.body
  if (!body) return null
  const view = doc.defaultView
  const radius = reachFrom(x, y, view?.innerWidth ?? 1280, view?.innerHeight ?? 800)
  const ring = doc.createElement('span')
  ring.setAttribute('aria-hidden', 'true')
  ring.dataset.testid = 'switch-ripple'
  ring.className = 'switch-ripple'
  ring.style.left = `${x - radius}px`
  ring.style.top = `${y - radius}px`
  ring.style.width = `${radius * 2}px`
  ring.style.height = `${radius * 2}px`
  body.appendChild(ring)
  playWave(x, y, doc.getElementById('root'), doc)
  const done = () => ring.remove()
  if (typeof ring.animate === 'function') {
    const anim = ring.animate(
      [
        { transform: 'scale(0.02)', opacity: 1 },
        { transform: 'scale(0.75)', opacity: 0.85, offset: 0.55 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: RIPPLE_MS, easing: 'cubic-bezier(0.3, 0.85, 0.45, 1)', fill: 'forwards' },
    )
    anim.onfinish = done
    anim.oncancel = done
  }
  // A backstop when animations don't run (tests, a hidden tab).
  setTimeout(done, RIPPLE_MS + 100)
  return ring
}

let context: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (context) return context
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  context = new Ctor()
  return context
}

/**
 * Lets the tick play in Safari and the Mac app, which only start audio while handling a click or
 * key press: called from those, before the tool changes. Plays a silent blip to wake the audio.
 */
export function unlockAudio(): void {
  try {
    const ctx = audioContext()
    if (!ctx || ctx.state === 'running') return
    void ctx.resume()
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
  } catch {}
}

/**
 * A soft wooden tick, made in the page (no file to fetch): a short sine blip that drops in pitch
 * and fades out in about 90 ms, quiet enough to sit under music. Silent until audio was unlocked.
 */
export function playTick(): void {
  try {
    const ctx = audioContext()
    if (!ctx || ctx.state !== 'running') return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.08)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.1)
  } catch {
    // No audio here: the switch is silent.
  }
}
