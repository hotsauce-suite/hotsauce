// What a key does during a slide show (docs/PLAN-slides.md R5, R7, R8). Pure, so every key's
// meaning is tested without a page; SlideShow applies the result and runs its effect.

export type ShowMode = 'slides' | 'presenter'

export interface ShowState {
  index: number
  total: number
  mode: ShowMode
  /** The screen is blacked out (B). */
  black: boolean
  laser: boolean
  /** Digits typed so far, for "number then Enter". */
  jump: string
}

/** What the page must do beyond showing the new state. */
export type ShowEffect = 'close' | 'fullscreen' | null

export function startShow(total: number, mode: ShowMode): ShowState {
  return { index: 0, total, mode, black: false, laser: false, jump: '' }
}

const clamp = (s: ShowState, index: number): ShowState => ({
  ...s,
  index: Math.max(0, Math.min(s.total - 1, index)),
  jump: '',
})

export const next = (s: ShowState) => clamp(s, s.index + 1)
export const previous = (s: ShowState) => clamp(s, s.index - 1)
export const goTo = (s: ShowState, index: number) => clamp(s, index)

const FORWARD = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'n'])
const BACK = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'])

/**
 * The state after a key, and what else to do. `handled` false: the key means nothing here and
 * may go on to the page (⌘R, ⌘Tab and the like never reach this).
 */
export function onKey(
  s: ShowState,
  key: string,
): { state: ShowState; effect: ShowEffect; handled: boolean } {
  const done = (state: ShowState, effect: ShowEffect = null) => ({ state, effect, handled: true })
  // A blacked-out screen comes back on any key, and only that happens.
  if (s.black) return done({ ...s, black: false, jump: '' })
  if (/^[0-9]$/.test(key)) return done({ ...s, jump: (s.jump + key).slice(-4) })
  if (key === 'Enter') {
    if (s.jump !== '') return done(goTo(s, Number(s.jump) - 1))
    return done(next(s))
  }
  if (FORWARD.has(key)) return done(next(s))
  if (BACK.has(key)) return done(previous(s))
  if (key === 'Home') return done(goTo(s, 0))
  if (key === 'End') return done(goTo(s, s.total - 1))
  if (key === 'Escape') return done({ ...s, jump: '' }, s.jump !== '' ? null : 'close')
  const lower = key.toLowerCase()
  if (lower === 'b' || key === '.') return done({ ...s, black: true, jump: '' })
  if (lower === 'l') return done({ ...s, laser: !s.laser, jump: '' })
  if (lower === 'p') {
    return done({ ...s, mode: s.mode === 'slides' ? 'presenter' : 'slides', jump: '' })
  }
  if (lower === 'f') return done({ ...s, jump: '' }, 'fullscreen')
  return { state: s, effect: null, handled: false }
}

/** "12:05" from milliseconds; hours when the talk runs past one. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
