// The camera bubble and recording controls in a Document Picture-in-Picture window (Chrome 116+):
// an always-on-top window over every app, so a recording of the whole screen has the camera in
// it, and Stop is one click away whatever is in front. Its own React root: React's events don't
// cross into another window's document from a portal.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { product } from '../../../brand/product'
import { Icon } from '../../../components/Icon'
import { formatDuration } from '../format'
import { elapsedMs, type RecordingSession } from './session'

interface PipApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

export function pipSupported(): boolean {
  return 'documentPictureInPicture' in window
}

/** Sizes of the window: the round camera with controls under it, or the controls alone. */
export const BUBBLE_SIZE = { width: 232, height: 300 }
export const CONTROLS_SIZE = { width: 300, height: 76 }

/**
 * Opens the window. `requestWindow` is called synchronously, so this must run inside the click
 * (after the share picker is asked for). The app's styles are copied into it.
 */
export async function openPipWindow(size: { width: number; height: number }): Promise<Window> {
  const api = (window as unknown as { documentPictureInPicture: PipApi }).documentPictureInPicture
  const pip = await api.requestWindow(size)
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    pip.document.head.appendChild(node.cloneNode(true))
  }
  pip.document.title = `${product()} Clips`
  pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? ''
  pip.document.body.className = 'clip-pip-body'
  return pip
}

/** Renders the bubble into `win` until the returned function is called. */
export function mountBubble(
  win: Window,
  props: { session: RecordingSession; camera: MediaStream | null },
): () => void {
  const host = win.document.createElement('div')
  win.document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(<BubbleView {...props} win={win} />)
  return () => {
    root.unmount()
    host.remove()
  }
}

/** The bubble and controls; also drawn inside the page where Document PiP isn't available. */
export function BubbleView({
  session,
  camera,
  win = window,
  inPage = false,
}: {
  session: RecordingSession
  camera: MediaStream | null
  win?: Window
  inPage?: boolean
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const video = useRef<HTMLVideoElement>(null)
  const [now, setNow] = useState(() => performance.now())
  // Discard takes a second click, so a slip doesn't throw a recording away.
  const [armed, setArmed] = useState(false)

  // This window's own timer: it's visible while the Hearth tab is hidden and throttled.
  useEffect(() => {
    const timer = win.setInterval(() => setNow(performance.now()), 250)
    return () => win.clearInterval(timer)
  }, [win])

  useEffect(() => {
    if (video.current && camera) video.current.srcObject = camera
  }, [camera])

  const recording = state.phase === 'recording' || state.phase === 'paused'
  return (
    <div className={`clip-bubble ${inPage ? 'clip-bubble--page' : ''}`} data-testid="clip-bubble">
      {camera ? (
        <div className="clip-bubble__cam">
          <video ref={video} autoPlay muted playsInline />
          {state.phase === 'countdown' ? (
            <span className="clip-bubble__count" key={state.countdown}>
              {state.countdown}
            </span>
          ) : null}
        </div>
      ) : state.phase === 'countdown' ? (
        <span className="clip-bubble__count clip-bubble__count--bare" key={state.countdown}>
          {state.countdown}
        </span>
      ) : null}
      {recording ? (
        <div className="clip-bubble__bar">
          <span
            className={`clip-rec-dot ${state.phase === 'paused' ? 'clip-rec-dot--paused' : ''}`}
            aria-hidden="true"
          />
          <span className="clip-bubble__time" data-testid="bubble-timer">
            {formatDuration(elapsedMs(state, now))}
          </span>
          <button
            type="button"
            title={state.phase === 'paused' ? 'Resume' : 'Pause'}
            aria-label={state.phase === 'paused' ? 'Resume' : 'Pause'}
            onClick={() => (state.phase === 'paused' ? session.resume() : session.pause())}
          >
            <Icon name={state.phase === 'paused' ? 'play' : 'pause'} />
          </button>
          <button
            type="button"
            title="Stop and save"
            aria-label="Stop and save"
            data-testid="bubble-stop"
            className="clip-bubble__stop"
            onClick={() => void session.stop()}
          >
            <Icon name="stop" />
          </button>
          <button
            type="button"
            title={armed ? 'Click again to discard' : 'Discard'}
            aria-label={armed ? 'Click again to discard' : 'Discard'}
            className={armed ? 'clip-bubble__armed' : ''}
            onClick={() => {
              if (armed) return session.cancel()
              setArmed(true)
              win.setTimeout(() => setArmed(false), 3000)
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
