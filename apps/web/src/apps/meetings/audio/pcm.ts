// Float32 audio → 16 kHz mono PCM16 little-endian, in 100 ms frames (ARCHITECTURE §7.3).
// Pure and dependency-free: the AudioWorklet imports this file, and so do the tests.

export const TARGET_RATE = 16_000
export const FRAME_MS = 100
export const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000
export const FRAME_BYTES = FRAME_SAMPLES * 2
/** Bytes of PCM per second of audio on one track. */
export const BYTES_PER_SECOND = TARGET_RATE * 2
/** The name worklet.ts registers its processor under. */
export const PCM_PROCESSOR = 'hearth-pcm-frames'

/** One sample in [-1, 1] → a signed 16-bit integer, clamped and rounded. */
export function toInt16(sample: number): number {
  const s = Number.isNaN(sample) ? 0 : Math.max(-1, Math.min(1, sample))
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

/** PCM16 LE bytes for `input`, two per sample, independent of the platform's byte order. */
export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < input.length; i++) view.setInt16(i * 2, toInt16(input[i] ?? 0), true)
  return out
}

/**
 * Streaming linear-interpolation resampler; state carries across blocks, so 128-sample worklet
 * blocks come out as one continuous signal. It does no anti-alias filtering: it only runs when
 * the browser can't give us a 16 kHz AudioContext, whose own resampling filters properly.
 */
export class Resampler {
  readonly ratio: number
  /** Next output position, in input samples, where index 0 is the previous block's last sample. */
  private t = 1
  private prev = 0

  constructor(
    readonly fromRate: number,
    readonly toRate: number = TARGET_RATE,
  ) {
    if (!(fromRate > 0 && toRate > 0)) throw new RangeError('sample rates must be positive')
    this.ratio = fromRate / toRate
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input
    const n = input.length
    if (n === 0) return new Float32Array(0)
    const out = new Float32Array(Math.ceil((n - this.t) / this.ratio) + 1)
    let count = 0
    let t = this.t
    while (t < n) {
      const i = Math.floor(t)
      const a = i === 0 ? this.prev : (input[i - 1] ?? 0)
      const b = input[i] ?? 0
      out[count++] = a + (b - a) * (t - i)
      t += this.ratio
    }
    this.t = t - n
    this.prev = input[n - 1] ?? 0
    return out.subarray(0, count)
  }
}

/** Collects audio at any input rate and hands back complete 100 ms PCM16 LE frames. */
export class PcmFramer {
  private readonly resampler: Resampler
  private readonly frame = new Uint8Array(FRAME_BYTES)
  private readonly view = new DataView(this.frame.buffer)
  private filled = 0

  constructor(inputRate: number) {
    this.resampler = new Resampler(inputRate)
  }

  push(block: Float32Array): Uint8Array[] {
    const samples = this.resampler.process(block)
    const frames: Uint8Array[] = []
    for (let i = 0; i < samples.length; i++) {
      this.view.setInt16(this.filled * 2, toInt16(samples[i] ?? 0), true)
      this.filled += 1
      if (this.filled === FRAME_SAMPLES) {
        frames.push(this.frame.slice())
        this.filled = 0
      }
    }
    return frames
  }
}
