// Light background music (docs/PLAN-background-music.md): one player for the whole page, so it
// keeps playing while the member moves between apps. Off until the member presses play; the
// choice, track and volume are remembered in this browser. It holds (fades out) while the page
// has a microphone, camera or screen capture open, so it never ends up in a recording.

import { DEFAULT_TRACK, TRACKS, trackById } from './tracks'

export const MUSIC_KEY = 'hotsauce:music'

export interface MusicPrefs {
  /** The member wants music on (it may still be waiting for a click, or held for a recording). */
  on: boolean
  track: string
  /** 0 to 1. */
  volume: number
  /** The Getting started offer was answered in this browser (Turn on or No thanks). */
  asked: boolean
}

export interface MusicState extends MusicPrefs {
  /** Sound is actually coming out now. */
  playing: boolean
  /** A recording is open, so the music waits. */
  held: boolean
  /** On, but the browser needs a click or key press before it may start. */
  waiting: boolean
}

export const DEFAULT_PREFS: MusicPrefs = {
  on: false,
  track: DEFAULT_TRACK,
  volume: 0.35,
  asked: false,
}

/** The bits of HTMLAudioElement the player uses (a fake in tests). */
export interface AudioLike {
  src: string
  loop: boolean
  volume: number
  preload: string
  paused: boolean
  play(): Promise<void>
  pause(): void
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface PlayerDeps {
  storage: StorageLike | null
  createAudio: () => AudioLike
  /** Where captures are opened; wrapped so a recording holds the music. */
  mediaDevices: MediaDevices | null
  /** Where the first click or key press after a reload is heard. */
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
}

const FADE_MS = 600
const FADE_STEPS = 12
/** How often a held recording is checked for having ended (a stopped track fires no event). */
const HOLD_POLL_MS = 1000

export function readPrefs(storage: StorageLike | null): MusicPrefs {
  try {
    const raw = storage?.getItem(MUSIC_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const v = JSON.parse(raw) as Partial<Record<keyof MusicPrefs, unknown>>
    return {
      on: v.on === true,
      track:
        typeof v.track === 'string' && TRACKS.some((t) => t.id === v.track)
          ? v.track
          : DEFAULT_TRACK,
      volume:
        typeof v.volume === 'number' && Number.isFinite(v.volume)
          ? Math.min(1, Math.max(0, v.volume))
          : DEFAULT_PREFS.volume,
      asked: v.asked === true,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export interface MusicPlayer {
  getState(): MusicState
  subscribe(listener: () => void): () => void
  /** Turn on and play (from a click, so the browser allows it). */
  play(): void
  /** Turn off. */
  stop(): void
  toggle(): void
  setTrack(id: string): void
  setVolume(volume: number): void
  /** The Getting started offer: "No thanks". */
  decline(): void
  /** Starts watching captures and, if music was left on, waits for the first click. Once. */
  start(): void
}

export function createMusicPlayer(deps: PlayerDeps): MusicPlayer {
  let prefs = readPrefs(deps.storage)
  let audio: AudioLike | null = null
  let playing = false
  let waiting = false
  const listeners = new Set<() => void>()
  const captures = new Set<MediaStream>()
  let holdTimer: unknown = null
  let fadeTimer: unknown = null
  let started = false
  let state = snapshot()

  function snapshot(): MusicState {
    return { ...prefs, playing, held: captures.size > 0, waiting }
  }
  function emit() {
    state = snapshot()
    for (const l of listeners) l()
  }
  function save() {
    try {
      deps.storage?.setItem(MUSIC_KEY, JSON.stringify(prefs))
    } catch {
      // No storage (private window): the choice lasts until the page reloads.
    }
  }

  function ensureAudio(): AudioLike {
    if (!audio) {
      audio = deps.createAudio()
      audio.loop = true
      audio.preload = 'auto'
      audio.volume = 0
      audio.src = trackById(prefs.track).file
    }
    return audio
  }

  function fadeTo(target: number, then?: () => void) {
    if (fadeTimer !== null) deps.clearTimer(fadeTimer)
    fadeTimer = null
    const a = audio
    if (!a) return then?.()
    const from = a.volume
    let step = 0
    const tick = () => {
      step += 1
      a.volume = Math.min(1, Math.max(0, from + ((target - from) * step) / FADE_STEPS))
      if (step < FADE_STEPS) fadeTimer = deps.setTimer(tick, FADE_MS / FADE_STEPS)
      else {
        fadeTimer = null
        then?.()
      }
    }
    tick()
  }

  /** Make the sound match the wishes: on, not held → playing; else paused. */
  function sync() {
    const want = prefs.on && captures.size === 0
    if (want && !playing) {
      const a = ensureAudio()
      // Older browsers return nothing from play().
      Promise.resolve(a.play()).then(
        () => {
          // Turned off or held while the browser was starting it.
          if (!prefs.on || captures.size > 0) {
            a.pause()
            return
          }
          playing = true
          waiting = false
          stopListening()
          emit()
          fadeTo(prefs.volume)
        },
        () => {
          // The browser wants a click first (after a reload). Try again on the next one.
          waiting = prefs.on
          emit()
        },
      )
    } else if (!want && playing) {
      playing = false
      emit()
      const a = audio
      fadeTo(0, () => {
        // Turned back on during the fade: keep playing.
        if (prefs.on && captures.size === 0) {
          playing = true
          emit()
          fadeTo(prefs.volume)
          return
        }
        a?.pause()
      })
    } else if (!want) {
      waiting = false
      emit()
    }
  }

  function setPrefs(next: Partial<MusicPrefs>) {
    prefs = { ...prefs, ...next }
    save()
    emit()
  }

  function onFirstGesture() {
    if (prefs.on && !playing) sync()
  }
  function stopListening() {
    deps.events?.removeEventListener('pointerdown', onFirstGesture, { capture: true })
    deps.events?.removeEventListener('keydown', onFirstGesture, { capture: true })
  }

  function checkCaptures() {
    holdTimer = null
    for (const s of captures) {
      if (s.getTracks().every((t) => t.readyState === 'ended')) captures.delete(s)
    }
    if (captures.size > 0) holdTimer = deps.setTimer(checkCaptures, HOLD_POLL_MS)
    else {
      emit()
      sync()
    }
  }

  function hold(stream: MediaStream) {
    captures.add(stream)
    emit()
    sync()
    if (holdTimer === null) holdTimer = deps.setTimer(checkCaptures, HOLD_POLL_MS)
  }

  function watchCaptures() {
    const md = deps.mediaDevices
    if (!md) return
    for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
      const original = md[name]
      if (typeof original !== 'function') continue
      const wrapped = async function (this: MediaDevices, constraints?: MediaStreamConstraints) {
        const stream = await (
          original as (c?: MediaStreamConstraints) => Promise<MediaStream>
        ).call(this, constraints)
        hold(stream)
        return stream
      }
      try {
        Object.defineProperty(md, name, { value: wrapped, configurable: true, writable: true })
      } catch {
        // A browser that won't let it be wrapped: the music just doesn't pause for recordings.
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    play() {
      setPrefs({ on: true, asked: true })
      sync()
    },
    stop() {
      setPrefs({ on: false })
      sync()
    },
    toggle() {
      if (prefs.on) this.stop()
      else this.play()
    },
    setTrack(id) {
      const track = trackById(id)
      if (track.id === prefs.track) return
      setPrefs({ track: track.id })
      if (audio) {
        const wasPlaying = playing
        audio.pause()
        audio.src = track.file
        playing = false
        if (wasPlaying) audio.volume = 0
        sync()
      }
    },
    setVolume(volume) {
      const v = Math.min(1, Math.max(0, volume))
      setPrefs({ volume: v })
      if (playing && audio && fadeTimer === null) audio.volume = v
      else if (playing) fadeTo(v)
    },
    decline() {
      setPrefs({ asked: true })
    },
    start() {
      if (started) return
      started = true
      watchCaptures()
      if (prefs.on) {
        waiting = true
        emit()
        deps.events?.addEventListener('pointerdown', onFirstGesture, { capture: true })
        deps.events?.addEventListener('keydown', onFirstGesture, { capture: true })
      }
    },
  }
}

function browserDeps(): PlayerDeps {
  const hasWindow = typeof window !== 'undefined'
  let storage: StorageLike | null = null
  try {
    storage = hasWindow ? window.localStorage : null
  } catch {
    storage = null
  }
  return {
    storage,
    createAudio: () => new Audio(),
    mediaDevices: hasWindow ? (navigator.mediaDevices ?? null) : null,
    events: hasWindow ? window : null,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}

let shared: MusicPlayer | null = null

/** Tests only: forget the page's player, so the next one reads storage afresh. */
export function resetMusicForTests(): void {
  shared = null
}

/** The page's one player. */
export function music(): MusicPlayer {
  shared ??= createMusicPlayer(browserDeps())
  return shared
}
