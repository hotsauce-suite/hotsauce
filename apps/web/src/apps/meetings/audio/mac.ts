// "Any app on this Mac" (docs/PLAN-record-any-call.md): inside the Hearth Mac app, the app
// records the microphone (echo cancelled) as "me" and everything the Mac plays as "them", and
// hands this page 100 ms PCM16 frames. The page sends them on the meeting socket like any other.

import type { Track } from '../../../api/types'
import { product } from '../../../brand/product'
import { type Capture, CaptureError, type CaptureFailure, type FrameSource } from './capture'

/** The app's side of the bridge, as WebKit exposes it. */
export interface MacBridge {
  postMessage(message: unknown): Promise<unknown>
}

export const MAC_AUDIO_EVENT = 'hearth-mac-audio'

type MacWindow = Window & {
  hearthMac?: { meetingAudio?: number }
  webkit?: { messageHandlers?: { hearthMeetingAudio?: MacBridge } }
}

/** The app's bridge, when this page runs in a Hearth Mac app that can record the whole Mac. */
export function macBridge(win: Window = window): MacBridge | null {
  const w = win as MacWindow
  if (!w.hearthMac?.meetingAudio) return null
  return w.webkit?.messageHandlers?.hearthMeetingAudio ?? null
}

export function supportsMacCapture(win: Window = window): boolean {
  return macBridge(win) !== null
}

type StartReply = { ok: true; session: string } | { ok: false; reason?: string; message?: string }

type MacEvent =
  | { session: string; type: 'frames'; me?: string; them?: string }
  | { session: string; type: 'ended'; track: Track }
  | { session: string; type: 'call-ended' }

const FAILURES: CaptureFailure[] = ['denied', 'no-mic', 'unsupported']

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Starts the app's capture. The capture's `frames` deliver its audio; `streams` is empty. */
export async function captureMac(
  bridge: MacBridge | null = macBridge(),
  win: Window = window,
): Promise<Capture> {
  if (!bridge) {
    throw new CaptureError(
      'unsupported',
      `Recording any app needs the ${product()} Mac app on macOS 14.2 or newer.`,
    )
  }
  let reply: StartReply
  try {
    reply = (await bridge.postMessage({ type: 'start' })) as StartReply
  } catch {
    throw new CaptureError('unsupported', `The ${product()} app couldn’t start recording.`)
  }
  if (reply?.ok !== true || typeof reply.session !== 'string') {
    const failed = reply?.ok === false ? reply : null
    const reason = FAILURES.find((r) => r === failed?.reason) ?? 'unsupported'
    throw new CaptureError(
      reason,
      failed?.message || `The ${product()} app couldn’t start recording.`,
    )
  }
  const session = reply.session

  const frameListeners = new Set<(track: Track, pcm: Uint8Array) => void>()
  const endedListeners = new Set<(track: Track) => void>()
  const callEndedListeners = new Set<() => void>()
  let stopped = false

  const onEvent = (event: Event) => {
    if (stopped) return
    const detail = (event as CustomEvent<MacEvent>).detail
    if (!detail || detail.session !== session) return
    if (detail.type === 'frames') {
      for (const track of ['me', 'them'] as const) {
        const data = detail[track]
        if (typeof data !== 'string' || data.length === 0) continue
        const pcm = decode(data)
        for (const listener of frameListeners) listener(track, pcm)
      }
    } else if (detail.type === 'ended' && (detail.track === 'me' || detail.track === 'them')) {
      for (const listener of endedListeners) listener(detail.track)
    } else if (detail.type === 'call-ended') {
      for (const listener of callEndedListeners) listener()
    }
  }
  win.addEventListener(MAC_AUDIO_EVENT, onEvent)

  let paused = false
  const frames: FrameSource = {
    tracks: ['me', 'them'],
    onFrame: (listener) => {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    setPaused: (next) => {
      if (stopped || next === paused) return
      paused = next
      void bridge.postMessage({ type: next ? 'pause' : 'resume', session }).catch(() => {})
    },
  }

  return {
    mode: 'mac',
    streams: {},
    frames,
    onEnded: (listener) => {
      endedListeners.add(listener)
      return () => endedListeners.delete(listener)
    },
    onCallEnded: (listener) => {
      callEndedListeners.add(listener)
      return () => callEndedListeners.delete(listener)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      win.removeEventListener(MAC_AUDIO_EVENT, onEvent)
      frameListeners.clear()
      callEndedListeners.clear()
      void bridge.postMessage({ type: 'stop', session }).catch(() => {})
    },
  }
}

/** Peak magnitude (0…1) of a PCM16 LE frame. */
export function pcmPeak(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let peak = 0
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(i, true)))
  }
  return peak / 32768
}

/** Like `audioArrived`, for a frame source: true once a non-silent frame arrives on `track`. */
export function framesArrived(
  frames: FrameSource,
  track: Track,
  opts: { timeoutMs?: number; threshold?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const threshold = opts.threshold ?? 0.0005
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    unsubscribe = frames.onFrame((t, pcm) => {
      if (t !== track || pcmPeak(pcm) <= threshold) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}

/** The Mac app's frames are already 100 ms of 16 kHz PCM16: passed through, or dropped while paused. */
export function frameRecorder(
  frames: FrameSource,
  onFrame: (track: Track, pcm: Uint8Array) => void,
): { setPaused: (paused: boolean) => void; stop: () => Promise<void> } {
  let paused = false
  let unsubscribe: (() => void) | null = frames.onFrame((track, pcm) => {
    if (!paused) onFrame(track, pcm)
  })
  return {
    setPaused: (next) => {
      paused = next
      frames.setPaused?.(next)
    },
    stop: async () => {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
