// Getting the two tracks (Meetings PRD §6.2): "them" is the Google Meet tab's audio, from the
// Hearth extension when it's installed and otherwise from the share picker; "me" is the
// microphone. Mic-only mode covers in-person meetings and phones. In the Hearth Mac app, "mac"
// mode has the app record the mic and everything the Mac plays (./mac.ts).

import type { Track } from '../../../api/types'
import { product } from '../../../brand/product'
import { meetTabFromExtension } from './extension'
import { captureMac } from './mac'

export type CaptureMode = 'meet-tab' | 'mic-only' | 'mac'

export type CaptureFailure =
  /** The person (or the browser) refused the picker or the microphone. */
  | 'denied'
  /** A tab was shared without "Share tab audio" ticked. */
  | 'no-tab-audio'
  /** No microphone, or it's in use elsewhere. */
  | 'no-mic'
  /** This browser can't share tab audio (Safari, Firefox, phones). */
  | 'unsupported'

export class CaptureError extends Error {
  constructor(
    readonly reason: CaptureFailure,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Audio that arrives as ready-made PCM16 frames (16 kHz mono), not as media streams. */
export interface FrameSource {
  tracks: Track[]
  onFrame: (listener: (track: Track, pcm: Uint8Array) => void) => () => void
  /** Tells the source to stop listening while paused (the Mac app releases the mic). */
  setPaused?: (paused: boolean) => void
}

export interface Capture {
  mode: CaptureMode
  /** One stream per captured track (empty when `frames` carries the audio). */
  streams: Partial<Record<Track, MediaStream>>
  /** Set when the Mac app records: its frames, already converted. */
  frames?: FrameSource
  /** Fires when a track ends on its own: the Meet tab share was stopped, the mic unplugged. */
  onEnded: (listener: (track: Track) => void) => () => void
  /** The Mac app saw the call this recording runs through end (another app let go of the mic). */
  onCallEnded?: (listener: () => void) => () => void
  stop: () => void
}

type Media = Pick<MediaDevices, 'getUserMedia'> & Partial<Pick<MediaDevices, 'getDisplayMedia'>>

export function supportsTabCapture(
  media: Partial<Media> | undefined = navigator.mediaDevices,
): boolean {
  return typeof media?.getDisplayMedia === 'function'
}

function isDenied(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
  )
}

async function getMic(media: Media): Promise<MediaStream> {
  try {
    return await media.getUserMedia({ audio: true })
  } catch (err) {
    if (isDenied(err))
      throw new CaptureError('denied', `${product()} needs your microphone to hear you.`)
    throw new CaptureError('no-mic', 'No microphone was found, or another app is using it.')
  }
}

/** The Meet tab's audio without the share picker, or null to use the picker. */
export type TabSource = () => Promise<MediaStream | null>

/**
 * Asks for the tracks a mode needs. Call it straight from a click: Chrome only opens the share
 * picker during a user gesture. The tab comes first (from the extension, else the picker), then
 * the mic. `call` is the meeting's Meet code, when known, so the extension hands over that call.
 */
export async function captureAudio(
  mode: CaptureMode,
  call: string | null = null,
  media: Media = navigator.mediaDevices,
  tabSource: TabSource = () => meetTabFromExtension(call, media),
): Promise<Capture> {
  if (mode === 'mac') return captureMac()
  const streams: Partial<Record<Track, MediaStream>> = {}

  if (mode === 'meet-tab') {
    streams.them = (await tabSource().catch(() => null)) ?? (await shareTab(media))
    try {
      streams.me = await getMic(media)
    } catch (err) {
      for (const track of streams.them.getTracks()) track.stop()
      throw err
    }
  } else {
    streams.me = await getMic(media)
  }

  const listeners = new Set<(track: Track) => void>()
  let stopped = false
  for (const [track, stream] of Object.entries(streams) as Array<[Track, MediaStream]>) {
    for (const mediaTrack of stream.getAudioTracks()) {
      mediaTrack.addEventListener('ended', () => {
        if (!stopped) for (const listener of listeners) listener(track)
      })
    }
  }

  return {
    mode,
    streams,
    onEnded: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: () => {
      stopped = true
      for (const stream of Object.values(streams)) for (const t of stream.getTracks()) t.stop()
    },
  }
}

/** Chrome's share dialog, for the Meet tab with its audio. */
async function shareTab(media: Media): Promise<MediaStream> {
  if (!media.getDisplayMedia) {
    throw new CaptureError(
      'unsupported',
      'Sharing a tab’s audio needs Chrome or Edge on a computer.',
    )
  }
  let display: MediaStream
  try {
    // Chrome won't share tab audio without video. We never record video: its track is
    // stopped as soon as the share starts.
    display = await media.getDisplayMedia({
      video: true,
      audio: true,
      selfBrowserSurface: 'exclude',
      systemAudio: 'exclude',
    } as DisplayMediaStreamOptions)
  } catch (err) {
    throw new CaptureError(
      isDenied(err) ? 'denied' : 'unsupported',
      'The share was cancelled. Pick the Meet tab and tick “Share tab audio”.',
    )
  }
  for (const track of display.getVideoTracks()) {
    track.stop()
    display.removeTrack(track)
  }
  if (display.getAudioTracks().length === 0) {
    throw new CaptureError(
      'no-tab-audio',
      'That share has no sound. Share the Meet tab again and tick “Share tab audio”.',
    )
  }
  return display
}

// ---------------------------------------------------------------------------------------------
// "Is audio arriving?" (PRD §6.2: a check within 3 seconds, or a clear retry.)

/** The slice of AudioContext the check uses, so tests can stub it. */
export interface AnalyserContext {
  createMediaStreamSource(stream: MediaStream): {
    connect(node: AnalyserNode): unknown
    disconnect(): void
  }
  createAnalyser(): AnalyserNode
  resume(): Promise<void>
  close(): Promise<void>
}

export interface AudioArrivedOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Peak sample magnitude that counts as sound. Digital silence (a quiet tab) is exactly 0. */
  threshold?: number
  createContext?: () => AnalyserContext
}

/**
 * Resolves true as soon as a non-silent sample arrives on `stream`, false after `timeoutMs`.
 * The analyser window (4096 samples) is longer than the polling interval, so a short sound
 * between two polls is still seen.
 */
export function audioArrived(
  stream: MediaStream,
  opts: AudioArrivedOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const intervalMs = opts.intervalMs ?? 50
  const threshold = opts.threshold ?? 0.0005
  const context = (opts.createContext ?? (() => new AudioContext() as AnalyserContext))()
  // A context made after the permission prompt may start suspended; it would analyse silence.
  void context.resume().catch(() => {})
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 4096
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)

  return new Promise((resolve) => {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (arrived: boolean) => {
      if (timer) clearTimeout(timer)
      source.disconnect()
      void context.close().catch(() => {})
      resolve(arrived)
    }
    const poll = () => {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const s of samples) peak = Math.max(peak, Math.abs(s))
      if (peak > threshold) return finish(true)
      if (Date.now() - started >= timeoutMs) return finish(false)
      timer = setTimeout(poll, intervalMs)
    }
    timer = setTimeout(poll, intervalMs)
  })
}
