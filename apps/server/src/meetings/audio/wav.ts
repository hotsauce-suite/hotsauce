import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

// Session audio is 16 kHz mono PCM16 little-endian (ARCHITECTURE §7.1).
const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS = 16
export const WAV_HEADER_BYTES = 44

/** The 44-byte RIFF/WAVE header for `dataBytes` of session PCM. */
export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES)
  const blockAlign = (CHANNELS * BITS) / 8
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16) // PCM fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(CHANNELS, 22)
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * blockAlign, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(BITS, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** A WAV stream of a PCM file's first `pcmBytes` bytes, read from disk as it's sent. */
export function wavStream(pcmFile: string, pcmBytes: number): Readable {
  async function* chunks() {
    yield wavHeader(pcmBytes)
    if (pcmBytes > 0) yield* createReadStream(pcmFile, { start: 0, end: pcmBytes - 1 })
  }
  return Readable.from(chunks())
}

export function pcmSeconds(pcmBytes: number): number {
  return Math.round(pcmBytes / (SAMPLE_RATE * ((CHANNELS * BITS) / 8)))
}
