// The Easter eggs' little shows (docs/PLAN-easter-eggs.md): a shower of chili peppers (E1), a
// burst from a click (E5) and a soft sizzle (E2). Each sits above the page, ignores the pointer and
// removes itself, so it never delays or blocks anything. With reduced motion nothing moves.

import { reducedMotion as deviceReducedMotion, recording } from '../components/useSwitchFx'
import { audioContext, readSwitchFx } from '../lib/switchFx'

const PEPPER = '🌶️'
export const SHOWER_MS = 2000
export const SHOWER_COUNT = 28
export const BURST_MS = 700
export const BURST_COUNT = 7

/** Remove after `ms`, however the animations went (tests, a hidden tab). */
function removeAfter(el: HTMLElement, ms: number) {
  setTimeout(() => el.remove(), ms)
}

function layer(doc: Document, testid: string): HTMLElement | null {
  if (!doc.body) return null
  const el = doc.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  el.dataset.testid = testid
  el.className = 'egg-layer'
  doc.body.appendChild(el)
  return el
}

/** A still 🌶 that fades in place: what reduced motion gets instead of a show. */
function stillBadge(doc: Document, x: number, y: number, text: string, testid: string) {
  const root = layer(doc, testid)
  if (!root) return null
  const badge = doc.createElement('span')
  badge.className = 'egg-badge'
  badge.textContent = text
  badge.style.left = `${x}px`
  badge.style.top = `${y}px`
  root.appendChild(badge)
  removeAfter(root, 1600)
  return root
}

export interface ShowOptions {
  reducedMotion?: boolean
  doc?: Document
  /** Random numbers, for tests. */
  random?: () => number
}

/** Peppers fall across the whole window for about two seconds (E1), with a sizzle if sounds are on. */
export function pepperShower(options: ShowOptions = {}): HTMLElement | null {
  const doc = options.doc ?? document
  const random = options.random ?? Math.random
  const still = options.reducedMotion ?? deviceReducedMotion()
  maybeSizzle()
  const view = doc.defaultView
  const width = view?.innerWidth ?? 1024
  const height = view?.innerHeight ?? 768
  if (still) return stillBadge(doc, width / 2, height / 3, `${PEPPER} Spicy!`, 'pepper-shower')
  const root = layer(doc, 'pepper-shower')
  if (!root) return null
  for (let i = 0; i < SHOWER_COUNT; i++) {
    const pepper = doc.createElement('span')
    pepper.className = 'egg-pepper'
    pepper.textContent = PEPPER
    const size = 18 + random() * 22
    pepper.style.fontSize = `${size}px`
    pepper.style.left = `${random() * width}px`
    pepper.style.top = `${-size * 2}px`
    root.appendChild(pepper)
    if (typeof pepper.animate === 'function') {
      const delay = random() * 700
      const spin = (random() - 0.5) * 540
      const drift = (random() - 0.5) * 120
      pepper.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
          {
            transform: `translate(${drift}px, ${height + size * 3}px) rotate(${spin}deg)`,
            opacity: 1,
          },
        ],
        {
          duration: SHOWER_MS - 700 + random() * 500,
          delay,
          easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)',
          fill: 'both',
        },
      )
    }
  }
  removeAfter(root, SHOWER_MS + 300)
  return root
}

/** A few peppers fly out from (x, y) and fade (E5). Reduced motion: nothing, the tick is enough. */
export function pepperBurst(x: number, y: number, options: ShowOptions = {}): HTMLElement | null {
  const doc = options.doc ?? document
  const random = options.random ?? Math.random
  if (options.reducedMotion ?? deviceReducedMotion()) return null
  const root = layer(doc, 'pepper-burst')
  if (!root) return null
  for (let i = 0; i < BURST_COUNT; i++) {
    const pepper = doc.createElement('span')
    pepper.className = 'egg-pepper'
    pepper.textContent = PEPPER
    pepper.style.fontSize = '16px'
    pepper.style.left = `${x - 8}px`
    pepper.style.top = `${y - 8}px`
    root.appendChild(pepper)
    if (typeof pepper.animate === 'function') {
      const angle = (i / BURST_COUNT) * Math.PI * 2 + random() * 0.6
      const reach = 36 + random() * 28
      pepper.animate(
        [
          { transform: 'translate(0, 0) scale(0.4)', opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * reach}px, ${Math.sin(angle) * reach}px) scale(1) rotate(${(random() - 0.5) * 180}deg)`,
            opacity: 0,
          },
        ],
        { duration: BURST_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
      )
    }
  }
  removeAfter(root, BURST_MS + 100)
  return root
}

/** Where the pointer last went down, so a burst can start from the click that caused it. */
let lastPointer: { x: number; y: number; at: number } | null = null
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() }
    },
    { capture: true, passive: true },
  )
}

/** Bursts from the click that completed the task (within the last second); nothing from a key. */
export function burstFromLastClick(): void {
  const p = lastPointer
  if (!p || Date.now() - p.at > 1000) return
  pepperBurst(p.x, p.y)
}

/** The sizzle plays only when the member turned sounds on and nothing records (E2). */
export function maybeSizzle(): void {
  if (!readSwitchFx().sound || recording()) return
  playSizzle()
}

/** A soft frying sizzle made in the page: filtered noise that swells and fades in ~0.7 s. */
export function playSizzle(): void {
  try {
    const ctx = audioContext()
    if (!ctx || ctx.state !== 'running') return
    const now = ctx.currentTime
    const seconds = 0.7
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      // Crackle: noise with the odd louder pop.
      data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.003 ? 1 : 0.35)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 2400
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.08)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds)
    source.connect(filter).connect(gain).connect(ctx.destination)
    source.start(now)
    source.stop(now + seconds)
  } catch {
    // No audio here: the shower is silent.
  }
}
