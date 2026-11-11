import { describe, expect, it } from 'vitest'
import { wavHeader } from '../meetings/audio/wav.js'
import { readWav } from './wav.js'

function wav(ms: number): Uint8Array {
  const pcm = new Uint8Array(ms * 32)
  const header = wavHeader(pcm.length)
  const out = new Uint8Array(header.length + pcm.length)
  out.set(header, 0)
  out.set(pcm, header.length)
  return out
}

describe('readWav', () => {
  it('reads a 16 kHz mono PCM16 WAV', () => {
    expect(readWav(wav(1500))).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 48000,
      durationMs: 1500,
    })
  })

  it('counts only the bytes present when the header says more (a streamed WAV)', () => {
    const bytes = wav(1000)
    new DataView(bytes.buffer).setUint32(40, 0xffffffff, true)
    expect(readWav(bytes)?.durationMs).toBe(1000)
  })

  it('refuses what isn’t a WAV', () => {
    expect(readWav(new Uint8Array(0))).toBeNull()
    expect(readWav(new TextEncoder().encode('RIFF....AVI LIST'))).toBeNull()
    expect(readWav(new Uint8Array(100))).toBeNull()
  })
})
