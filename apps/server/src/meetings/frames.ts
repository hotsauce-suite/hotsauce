import type { Track } from './transcriber/types.js'

const TRACK_BYTE: Record<number, Track> = { 0: 'me', 1: 'them' }

/**
 * A binary audio frame from `/ws/meetings/:id`: byte 0 is the track (0 me, 1 them), the rest is
 * 16 kHz mono PCM16 little-endian, so an even number of bytes.
 */
export function parseAudioFrame(
  frame: Uint8Array,
): { track: Track; pcm: Uint8Array } | { error: string } {
  const track = frame.length > 0 ? TRACK_BYTE[frame[0] ?? -1] : undefined
  if (!track) return { error: 'Audio frames start with a track byte: 0 me, 1 them' }
  const pcm = frame.subarray(1)
  if (pcm.length % 2 !== 0) return { error: 'PCM16 audio needs an even number of bytes' }
  return { track, pcm }
}

/** The frame a client sends: the track byte, then the PCM. */
export function audioFrame(track: Track, pcm: Uint8Array): Uint8Array {
  const frame = new Uint8Array(pcm.length + 1)
  frame[0] = track === 'me' ? 0 : 1
  frame.set(pcm, 1)
  return frame
}
