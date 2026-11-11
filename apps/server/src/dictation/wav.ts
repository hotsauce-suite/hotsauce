/** What a WAV file's header says about it; null when the bytes aren't a PCM WAV we can read. */
export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataBytes: number
  durationMs: number
}

/**
 * Reads a RIFF/WAVE header by walking its chunks for `fmt ` and `data`. Used to refuse an
 * over-long dictation before paying to transcribe it, and by the fake transcriber.
 */
export function readWav(buf: Uint8Array): WavInfo | null {
  if (buf.length < 12) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (at: number) => String.fromCharCode(...buf.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!fmt || fmt.channels === 0 || fmt.sampleRate === 0 || fmt.bitsPerSample === 0) {
        return null
      }
      // A streamed WAV may say 0 or 0xFFFFFFFF; trust the bytes actually present.
      const dataBytes = Math.min(size, buf.length - body)
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)
      return { ...fmt, dataBytes, durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) }
    }
    offset = body + size + (size % 2)
  }
  return null
}
