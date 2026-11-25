import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSound, SOUND_THEMES, SOUNDS, soundLength } from './dictateSounds'

const EVENTS = ['start', 'stop', 'send', 'cancel'] as const

describe('Dictate sounds (docs/PLAN-dictate-send-and-sounds.md, R6, R11)', () => {
  it('has every moment in every theme, each short', () => {
    for (const theme of SOUND_THEMES) {
      if (theme === 'off') continue
      for (const event of EVENTS) {
        const tones = SOUNDS[theme][event]
        expect(tones.length).toBeGreaterThan(0)
        expect(soundLength(tones)).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('makes the same samples every time, never past full scale', () => {
    for (const theme of ['soft', 'click'] as const) {
      const a = renderSound(SOUNDS[theme].send, 44_100)
      const b = renderSound(SOUNDS[theme].send, 44_100)
      expect(a).toEqual(b)
      expect(a.length).toBe(Math.ceil(soundLength(SOUNDS[theme].send) * 44_100))
      expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1)
      expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0.05)
      // It starts and ends quietly, so it never clicks.
      expect(Math.abs(a[0] ?? 1)).toBeLessThan(0.01)
      expect(Math.abs(a[a.length - 1] ?? 1)).toBeLessThan(0.01)
    }
  })

  it('keeps the same themes and tones as the Mac app', () => {
    const swift = readFileSync(
      path.resolve(__dirname, '../../../dictate-mac/Sources/DictateCore/DictateSounds.swift'),
      'utf8',
    )
    const cases = [...swift.matchAll(/^\s*case (\w+)$/gm)].map((m) => m[1])
    expect(cases).toEqual([...SOUND_THEMES])
    // Every tone, written the same way in both tables.
    for (const theme of SOUND_THEMES) {
      if (theme === 'off') continue
      for (const event of EVENTS)
        for (const t of SOUNDS[theme][event]) {
          const to = t.to === undefined ? '' : `, to: ${t.to}`
          expect(swift).toContain(
            `Tone(at: ${t.at}, dur: ${t.dur}, freq: ${t.freq}, wave: .${t.wave}, gain: ${t.gain}${to})`,
          )
        }
    }
  })
})
