/**
 * Dictate's sounds (docs/PLAN-dictate-send-and-sounds.md, R6, R11): a few short tones for each
 * moment, made here rather than shipped as audio files. The Mac app makes the same sounds from the
 * same table (`apps/dictate-mac/Sources/DictateCore/DictateSounds.swift`); keep the two in step.
 */

export const SOUND_THEMES = ['soft', 'pop', 'click', 'chime', 'off'] as const
export type SoundTheme = (typeof SOUND_THEMES)[number]
export type SoundEvent = 'start' | 'stop' | 'send' | 'cancel'

export const SOUND_THEME_LABELS: Record<SoundTheme, string> = {
  soft: 'Soft',
  pop: 'Pop',
  click: 'Click',
  chime: 'Chime',
  off: 'Off',
}

/** One tone: when it starts and how long it lasts (seconds), its pitch (Hz, gliding to `to`). */
export interface Tone {
  at: number
  dur: number
  freq: number
  to?: number
  wave: 'sine' | 'triangle' | 'noise'
  gain: number
}

type Sounds = Record<SoundEvent, Tone[]>

const tone = (
  at: number,
  dur: number,
  freq: number,
  wave: Tone['wave'],
  gain: number,
  to?: number,
): Tone => (to === undefined ? { at, dur, freq, wave, gain } : { at, dur, freq, wave, gain, to })

export const SOUNDS: Record<Exclude<SoundTheme, 'off'>, Sounds> = {
  soft: {
    start: [tone(0, 0.12, 587, 'sine', 0.22, 880)],
    stop: [tone(0, 0.12, 880, 'sine', 0.22, 587)],
    send: [tone(0, 0.07, 784, 'sine', 0.2), tone(0.07, 0.11, 1175, 'sine', 0.2)],
    cancel: [tone(0, 0.14, 440, 'sine', 0.16, 330)],
  },
  pop: {
    start: [tone(0, 0.06, 400, 'triangle', 0.25, 900)],
    stop: [tone(0, 0.06, 900, 'triangle', 0.25, 400)],
    send: [
      tone(0, 0.05, 500, 'triangle', 0.22, 1000),
      tone(0.06, 0.05, 700, 'triangle', 0.22, 1400),
    ],
    cancel: [tone(0, 0.08, 300, 'triangle', 0.2, 200)],
  },
  click: {
    start: [tone(0, 0.012, 0, 'noise', 0.3), tone(0, 0.03, 1800, 'sine', 0.15)],
    stop: [tone(0, 0.012, 0, 'noise', 0.3), tone(0, 0.03, 1200, 'sine', 0.15)],
    send: [
      tone(0, 0.012, 0, 'noise', 0.3),
      tone(0.05, 0.012, 0, 'noise', 0.3),
      tone(0.05, 0.03, 2200, 'sine', 0.12),
    ],
    cancel: [tone(0, 0.02, 0, 'noise', 0.2)],
  },
  chime: {
    start: [tone(0, 0.35, 1318, 'sine', 0.14), tone(0, 0.35, 1975, 'sine', 0.06)],
    stop: [tone(0, 0.35, 988, 'sine', 0.14), tone(0, 0.35, 1480, 'sine', 0.06)],
    send: [tone(0, 0.25, 1318, 'sine', 0.12), tone(0.09, 0.4, 1760, 'sine', 0.12)],
    cancel: [tone(0, 0.3, 660, 'sine', 0.1)],
  },
}

/** How long a sound lasts, in seconds. */
export function soundLength(tones: Tone[]): number {
  return tones.reduce((end, t) => Math.max(end, t.at + t.dur), 0)
}

/**
 * The samples of a sound, between -1 and 1. Each tone rises over 4 ms and dies away; the noise is
 * the same every time (a fixed seed), so a sound is always the same sound.
 */
export function renderSound(tones: Tone[], sampleRate: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.ceil(soundLength(tones) * sampleRate))
  for (const t of tones) {
    const start = Math.round(t.at * sampleRate)
    const length = Math.round(t.dur * sampleRate)
    let phase = 0
    let seed = 22222
    for (let i = 0; i < length && start + i < out.length; i++) {
      const time = i / sampleRate
      const progress = i / length
      const freq = t.freq + ((t.to ?? t.freq) - t.freq) * progress
      phase += (2 * Math.PI * freq) / sampleRate
      let wave: number
      if (t.wave === 'noise') {
        seed = (seed * 16807) % 2147483647
        wave = (seed / 2147483647) * 2 - 1
      } else if (t.wave === 'triangle') {
        wave = (2 / Math.PI) * Math.asin(Math.sin(phase))
      } else {
        wave = Math.sin(phase)
      }
      const attack = Math.min(1, time / 0.004)
      const envelope =
        attack * Math.exp(-5 * progress) * Math.min(1, (length - i) / (0.005 * sampleRate))
      out[start + i] = (out[start + i] ?? 0) + wave * t.gain * envelope
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] ?? 0))
  return out
}

let context: AudioContext | null = null

/** Plays a moment's sound in the member's theme; `off`, or a browser without sound, is silent. */
export function playDictateSound(theme: SoundTheme, event: SoundEvent): void {
  if (theme === 'off' || typeof window === 'undefined' || typeof AudioContext === 'undefined')
    return
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const samples = renderSound(SOUNDS[theme][event], context.sampleRate)
    if (samples.length === 0) return
    const buffer = context.createBuffer(1, samples.length, context.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start()
  } catch {
    // A sound is a nicety: never let it stop a dictation.
  }
}
