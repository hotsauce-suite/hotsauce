// What a recording is doing, at a glance: the red light and timer, what's shared, which mic and
// camera, and a meter that moves with the mic. Drawn in the floating window and on the page.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../components/Icon'
import { formatDuration } from '../format'
import { elapsedMs, type SessionState } from './session'

/** A mic that's this quiet for this long is probably muted or the wrong one. */
export const SILENT_PEAK = 0.02
export const SILENT_MS = 5000

const SURFACE: Record<string, string> = {
  monitor: 'Entire screen',
  window: 'A window',
  browser: 'A Chrome tab',
}

/**
 * "Entire screen", "A window: Pricing – Figma", …: the kind of share from `displaySurface`, and
 * the browser's name for it when it's a person-readable one (not `screen:0:0`).
 */
export function describeShare(surface: string | null, label: string | null): string {
  const kind = (surface && SURFACE[surface]) ?? 'Your screen'
  const readable = label && !/^(screen|window|web-contents-media-stream):/i.test(label)
  return readable && surface !== 'monitor' ? `${kind}: ${label}` : kind
}

/** A device's name from its track, without Chrome's "(1a2b:3c4d)" USB ids. */
export function deviceName(track: MediaStreamTrack | undefined, fallback: string): string {
  const label = track?.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
  return label || fallback
}

/**
 * The mic's level, drawn on `bar` each frame of `win` (the floating window keeps its frames when
 * the page is in the background), and whether it has been silent for five seconds.
 */
export function useMicLevel(stream: MediaStream | null, win: Window = window) {
  const bar = useRef<HTMLSpanElement>(null)
  const [silent, setSilent] = useState(false)
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return
    let context: AudioContext
    try {
      context = new AudioContext()
    } catch {
      return
    }
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    let frame = 0
    let lastSound = performance.now()
    let wasSilent = false
    const draw = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
      const now = performance.now()
      if (peak > SILENT_PEAK) lastSound = now
      const isSilent = now - lastSound > SILENT_MS
      if (isSilent !== wasSilent) {
        wasSilent = isSilent
        setSilent(isSilent)
      }
      if (bar.current) {
        bar.current.style.transform = `scaleX(${Math.min(1, peak * 2.2)})`
        bar.current.dataset.level = peak.toFixed(3)
      }
      frame = win.requestAnimationFrame(draw)
    }
    draw()
    return () => {
      win.cancelAnimationFrame(frame)
      source.disconnect()
      void context.close().catch(() => {})
    }
  }, [stream, win])
  return { bar, silent }
}

export function MicMeter({
  stream,
  win,
  testId,
}: {
  stream: MediaStream | null
  win?: Window
  testId?: string
}) {
  const { bar, silent } = useMicLevel(stream, win)
  return (
    <>
      <span className="clip-level" aria-hidden="true">
        <span ref={bar} data-testid={testId} />
      </span>
      {stream && silent ? (
        <span className="clip-status__warn" role="status" data-testid="mic-silent">
          No sound from this mic for 5 seconds. Is it muted, or the wrong one?
        </span>
      ) : null}
    </>
  )
}

/** The recording light, the timer, and what's being recorded from. */
export function RecordingStatus({
  state,
  mic,
  camera,
  win = window,
  compact = false,
}: {
  state: SessionState
  mic: MediaStream | null
  camera: MediaStream | null
  win?: Window
  compact?: boolean
}) {
  const [now, setNow] = useState(() => performance.now())
  // This window's own timer: the floating one stays visible while the Hearth tab is throttled.
  useEffect(() => {
    const timer = win.setInterval(() => setNow(performance.now()), 250)
    return () => win.clearInterval(timer)
  }, [win])
  const paused = state.phase === 'paused'
  const live = state.phase === 'recording' || paused
  const screen = state.surface !== null || state.screenLabel !== null
  return (
    <div
      className={`clip-status ${compact ? 'clip-status--compact' : ''}`}
      data-testid="recording-status"
    >
      <div className="clip-status__head">
        <span
          className={`clip-rec-dot ${paused ? 'clip-rec-dot--paused' : ''}`}
          aria-hidden="true"
        />
        <span className="clip-status__state">
          {state.phase === 'countdown'
            ? 'Starting…'
            : paused
              ? 'Paused'
              : live
                ? 'Recording'
                : 'Ready'}
        </span>
        <span className="clip-status__time" data-testid="status-timer">
          {formatDuration(elapsedMs(state, now))}
        </span>
      </div>
      {screen ? (
        <div className="clip-status__row" data-testid="status-screen">
          <Icon name="tab" className="size-3.5 shrink-0" />
          <span className="truncate">{describeShare(state.surface, state.screenLabel)}</span>
        </div>
      ) : null}
      {state.screenMuted ? (
        <span className="clip-status__warn" role="status" data-testid="screen-muted">
          Your screen isn’t sending a picture. Is the shared window minimized?
        </span>
      ) : null}
      <div className="clip-status__row" data-testid="status-mic">
        <Icon name="mic" className="size-3.5 shrink-0" />
        <span className="truncate">
          {mic ? deviceName(mic.getAudioTracks()[0], 'Microphone') : 'No microphone'}
        </span>
      </div>
      {mic ? <MicMeter stream={mic} win={win} testId="status-mic-level" /> : null}
      {camera ? (
        <div className="clip-status__row" data-testid="status-camera">
          <Icon name="video" className="size-3.5 shrink-0" />
          <span className="truncate">{deviceName(camera.getVideoTracks()[0], 'Camera')}</span>
        </div>
      ) : null}
    </div>
  )
}
