/** `me` is the member's microphone; `them` is the call's audio (the shared Meet tab). */
export type Track = 'me' | 'them'

export const TRACKS: readonly Track[] = ['me', 'them']

export interface TranscriptSegment {
  track: Track
  speaker: string
  /** Milliseconds of audio on the track before this segment starts (paused time isn't audio). */
  at: number
  durationMs: number
  text: string
  /** Partials (`false`) replace the previous partial on the same track; finals are kept. */
  final: boolean
}

export interface TranscriberSession {
  /** 16 kHz mono PCM16 little-endian, per track. */
  sendAudio(track: Track, pcm16: Uint8Array): void
  /** Flushes buffered audio; after it resolves there are no more events. */
  finish(): Promise<void>
  on(event: 'segment', cb: (seg: TranscriptSegment) => void): () => void
  on(event: 'error', cb: (err: Error) => void): () => void
}

export interface Transcriber {
  start(opts: {
    sessionId: string
    language?: string
    vocabulary?: string[]
    /** Treat a dropped connection as an error instead of reconnecting (Hearth Dictate). */
    failOnDrop?: boolean
  }): Promise<TranscriberSession>
}

/** 16,000 samples a second, two bytes each. */
export const PCM_BYTES_PER_MS = 32

/** Speakers are the tracks until diarization (PRD §6.2, P1). */
export function speakerFor(track: Track): string {
  return track === 'me' ? 'Me' : 'Them'
}
