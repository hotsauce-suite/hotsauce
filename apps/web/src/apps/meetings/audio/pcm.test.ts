import { describe, expect, it } from 'vitest'
import {
  FRAME_BYTES,
  FRAME_SAMPLES,
  floatToPcm16,
  PcmFramer,
  Resampler,
  TARGET_RATE,
  toInt16,
} from './pcm'

/** Feeds `input` through `resampler` in worklet-sized blocks and joins the output. */
function resampleInBlocks(resampler: Resampler, input: Float32Array, block = 128): Float32Array {
  const parts: number[] = []
  for (let i = 0; i < input.length; i += block) {
    parts.push(...resampler.process(input.subarray(i, i + block)))
  }
  return Float32Array.from(parts)
}

const readInt16 = (bytes: Uint8Array, i: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getInt16(i * 2, true)

describe('PCM16 conversion', () => {
  it('maps full scale to the int16 limits and clamps beyond it', () => {
    expect(toInt16(1)).toBe(32767)
    expect(toInt16(-1)).toBe(-32768)
    expect(toInt16(0)).toBe(0)
    expect(toInt16(2.5)).toBe(32767)
    expect(toInt16(-7)).toBe(-32768)
    expect(toInt16(Number.NaN)).toBe(0)
    expect(toInt16(0.5)).toBe(16384)
  })

  it('writes little-endian bytes, two per sample', () => {
    const bytes = floatToPcm16(Float32Array.from([1, -1, 0, 0.25]))
    expect(bytes.byteLength).toBe(8)
    // 32767 = 0x7fff → ff 7f; -32768 = 0x8000 → 00 80
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0x7f, 0x00, 0x80])
    expect(readInt16(bytes, 3)).toBe(8192)
  })
})

describe('Resampler', () => {
  it('passes 16 kHz through untouched', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3])
    expect(new Resampler(16_000).process(input)).toBe(input)
  })

  it('takes every third sample from 48 kHz, across block boundaries', () => {
    const input = Float32Array.from({ length: 48 * 30 }, (_, i) => i)
    const out = resampleInBlocks(new Resampler(48_000), input)
    expect(out.length).toBe(480)
    expect([...out.subarray(0, 4)]).toEqual([0, 3, 6, 9])
    // Block boundaries (every 128 input samples) leave no gap or repeat.
    for (let i = 1; i < out.length; i++) expect((out[i] ?? 0) - (out[i - 1] ?? 0)).toBeCloseTo(3)
  })

  it('produces one second of 16 kHz output from one second of 44.1 kHz input', () => {
    const input = new Float32Array(44_100).fill(0.5)
    const out = resampleInBlocks(new Resampler(44_100), input)
    expect(Math.abs(out.length - TARGET_RATE)).toBeLessThanOrEqual(1)
    expect(out.every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true)
  })

  it('interpolates a ramp linearly at a fractional ratio', () => {
    const input = Float32Array.from({ length: 2205 }, (_, i) => i / 2205)
    const out = resampleInBlocks(new Resampler(22_050), input, 100)
    const ratio = 22_050 / 16_000
    for (const [i, s] of out.entries()) expect(s).toBeCloseTo((i * ratio) / 2205, 5)
  })

  it('rejects a zero rate', () => {
    expect(() => new Resampler(0)).toThrow(RangeError)
  })
})

describe('PcmFramer', () => {
  it('emits 100 ms frames of 3200 bytes and keeps the remainder for the next push', () => {
    const framer = new PcmFramer(48_000)
    let frames: Uint8Array[] = []
    // 48 kHz × 0.25 s in 128-sample blocks → 4000 samples at 16 kHz → 2 full frames + 800.
    for (let i = 0; i < 12_000; i += 128) {
      frames = frames.concat(framer.push(new Float32Array(Math.min(128, 12_000 - i)).fill(0.5)))
    }
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(frame.byteLength).toBe(FRAME_BYTES)
      expect(readInt16(frame, 0)).toBe(16384)
      expect(readInt16(frame, FRAME_SAMPLES - 1)).toBe(16384)
    }
    // The next 50 ms completes the third frame.
    const more = framer.push(new Float32Array(2400).fill(-0.5))
    expect(more).toHaveLength(1)
    expect(readInt16(more[0] as Uint8Array, 0)).toBe(16384)
    expect(readInt16(more[0] as Uint8Array, FRAME_SAMPLES - 1)).toBe(-16384)
  })

  it('hands out frames that later pushes do not overwrite', () => {
    const framer = new PcmFramer(TARGET_RATE)
    const [first] = framer.push(new Float32Array(FRAME_SAMPLES).fill(0.25))
    framer.push(new Float32Array(FRAME_SAMPLES).fill(-0.25))
    expect(readInt16(first as Uint8Array, 10)).toBe(8192)
  })
})
