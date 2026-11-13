import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useBlocker, useNavigate } from 'react-router'
import { type ClipMode, clipsApi } from '../../api/clips'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon, type IconName } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { formatDuration } from './format'
import {
  BUBBLE_SIZE,
  BubbleView,
  CONTROLS_SIZE,
  mountBubble,
  openPipWindow,
  pipSupported,
} from './recorder/Bubble'
import {
  canRecord,
  type Devices,
  getCamera,
  getMic,
  isDenied,
  listDevices,
  pickCameraFormat,
  pickFormat,
  requestDisplay,
  stopStream,
} from './recorder/media'
import { MicMeter, RecordingStatus } from './recorder/Status'
import { elapsedMs, MAX_RECORDING_MS, RecordingSession } from './recorder/session'

const MODES: Array<{ id: ClipMode; label: string; hint: string; icon: IconName }> = [
  {
    id: 'screen_camera',
    label: 'Screen and camera',
    hint: 'You in a circle, over your screen',
    icon: 'video',
  },
  {
    id: 'screen',
    label: 'Screen only',
    hint: 'Just what’s on screen, and your voice',
    icon: 'tab',
  },
  { id: 'camera', label: 'Camera only', hint: 'Talk to the camera', icon: 'mic' },
]
const NO_MIC = 'none'

function defaultTitle(): string {
  const now = new Date()
  return `Clip, ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** `/clips/new`: choose what to record, see yourself, count down, record, stop. */
export default function RecordClip() {
  const navigate = useNavigate()
  const format = useMemo(() => pickFormat(), [])
  const cameraFormat = useMemo(() => pickCameraFormat(), [])
  // An iPad or a phone can't record its screen from a browser: start on the camera there.
  const canScreen = useMemo(() => canRecord('screen'), [])
  const [mode, setMode] = useState<ClipMode>(canScreen ? 'screen_camera' : 'camera')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const session = useMemo(
    () =>
      format
        ? new RecordingSession({
            api: clipsApi,
            format,
            cameraFormat,
            requestDisplay,
            openPip: pipSupported()
              ? () => openPipWindow(modeRef.current === 'screen' ? CONTROLS_SIZE : BUBBLE_SIZE)
              : null,
            createRecorder: (stream, options) => new MediaRecorder(stream, options),
          })
        : null,
    [format, cameraFormat],
  )
  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? nullSnapshot,
  )
  const phase = state?.phase ?? 'idle'
  const active = phase === 'countdown' || phase === 'recording' || phase === 'paused'
  const locked = phase !== 'idle'

  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] })
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [micId, setMicId] = useState<string | null>(null)
  const [camera, setCamera] = useState<MediaStream | null>(null)
  const [mic, setMic] = useState<MediaStream | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    clipsApi.config().then(
      (c) => setAvailable(c.available),
      () => setAvailable(true),
    )
  }, [])

  // The camera preview, while the mode uses the camera; the bubble shows the same stream. The
  // pickers are locked while recording, so these don't change under a recording.
  const wantsCamera = mode !== 'screen'
  useEffect(() => {
    if (!wantsCamera) return
    let stream: MediaStream | null = null
    let cancelled = false
    getCamera(cameraId).then(
      (s) => {
        if (cancelled) return stopStream(s)
        stream = s
        setCamera(s)
        setDeviceError(null)
        void listDevices().then(setDevices)
      },
      (err: unknown) => {
        if (cancelled) return
        setCamera(null)
        setDeviceError(
          isDenied(err)
            ? `${product()} can’t use your camera. Allow the camera for this site in your browser’s settings, then reload.`
            : 'No camera was found, or another app is using it.',
        )
      },
    )
    return () => {
      cancelled = true
      stopStream(stream)
      setCamera(null)
    }
  }, [wantsCamera, cameraId])

  useEffect(() => {
    if (micId === NO_MIC) return
    let stream: MediaStream | null = null
    let cancelled = false
    getMic(micId).then(
      (s) => {
        if (cancelled) return stopStream(s)
        stream = s
        setMic(s)
        void listDevices().then(setDevices)
      },
      (err: unknown) => {
        if (cancelled) return
        setMic(null)
        setDeviceError(
          isDenied(err)
            ? `${product()} can’t use your microphone. Allow it for this site in your browser’s settings, or record without sound.`
            : 'No microphone was found, or another app is using it.',
        )
      },
    )
    return () => {
      cancelled = true
      stopStream(stream)
      setMic(null)
    }
  }, [micId])

  // Leaving the page stops the capture (the camera and mic stop with their effects above).
  useEffect(() => () => session?.dispose(), [session])

  // The bubble's window, while it's open.
  const pipWindow = state?.pipWindow ?? null
  useEffect(() => {
    if (!pipWindow || !session) return
    return mountBubble(pipWindow, {
      session,
      camera: mode === 'screen_camera' ? camera : null,
      mic: micId === NO_MIC ? null : mic,
    })
  }, [pipWindow, session, camera, mode, mic, micId])

  useEffect(() => {
    if (phase === 'finished' && state?.clip) navigate(`/clips/${state.clip.id}`, { replace: true })
  }, [phase, state?.clip, navigate])

  // The tab's title is the timer, for when Hearth is in the background.
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) {
      document.title = `Record a clip · ${product()} Clips`
      return
    }
    const timer = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  const elapsed = state ? elapsedMs(state, now) : 0
  useEffect(() => {
    if (phase === 'recording' || phase === 'paused') {
      document.title = `${phase === 'paused' ? '❚❚' : '●'} ${formatDuration(elapsed)} · Recording`
    }
  }, [phase, elapsed])

  // Leaving mid-recording asks first: within Hearth, and closing the tab.
  // Read from a ref so the jump to the finished clip, made in the same commit, isn't blocked.
  // Not while saving: leaving then lets the save finish in the background (dispose).
  const guarding = useRef(false)
  guarding.current = active
  const blocker = useBlocker(() => guarding.current)
  useEffect(() => {
    if (!(active || phase === 'finishing')) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active, phase])

  const start = () => {
    if (!session) return
    void session.start({
      mode,
      title: defaultTitle(),
      camera: mode === 'screen' ? null : camera,
      mic: micId === NO_MIC ? null : mic,
    })
  }

  const unsupported = !format || !canRecord(mode)
  const needsCamera = mode === 'camera' && !camera
  const upload = state?.upload
  const behindBytes = upload?.pendingBytes ?? 0

  return (
    <>
      <MeetingsPageHeader title="Record a clip" />
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="clip-recorder"
        data-phase={phase}
      >
        <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 pt-6 pb-24 md:px-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:pt-10">
          <section className="clip-preview" aria-label="Preview">
            <div className={`clip-preview__screen clip-preview__screen--${mode}`}>
              {mode !== 'camera' ? (
                <div className="clip-preview__desk" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              {wantsCamera ? <PreviewCamera stream={camera} large={mode === 'camera'} /> : null}
              {phase === 'countdown' ? (
                <div className="clip-countdown" data-testid="countdown" key={state?.countdown}>
                  {state?.countdown}
                </div>
              ) : null}
              {phase === 'recording' || phase === 'paused' ? (
                <div className="clip-preview__live">
                  <span
                    className={`clip-rec-dot ${phase === 'paused' ? 'clip-rec-dot--paused' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-2xl tabular-nums" data-testid="recording-timer">
                    {formatDuration(elapsed)}
                  </span>
                  <span className="text-sm opacity-80">
                    {phase === 'paused' ? 'Paused' : 'Recording'}
                  </span>
                </div>
              ) : null}
            </div>
            {active ? (
              <p className="mt-3 text-sm text-ink-soft">
                {mode === 'camera'
                  ? 'Recording your camera.'
                  : state?.pipWindow
                    ? 'Recording. The controls float over your other windows; Stop is there too.'
                    : 'Recording. Come back to this tab to stop.'}{' '}
                {state?.cameraTrack
                  ? 'Your camera is recorded on its own and goes into the corner of the video when you stop.'
                  : ''}
              </p>
            ) : null}
          </section>

          <aside className="flex flex-col gap-5">
            {phase === 'idle' || phase === 'starting' ? (
              <>
                <fieldset className="clip-modes" disabled={locked}>
                  <legend className="mb-2 text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
                    Record
                  </legend>
                  {MODES.map((m) => (
                    <label key={m.id} className="clip-mode" data-testid={`clip-mode-${m.id}`}>
                      <input
                        type="radio"
                        name="mode"
                        value={m.id}
                        checked={mode === m.id}
                        disabled={!canScreen && m.id !== 'camera'}
                        onChange={() => setMode(m.id)}
                      />
                      <Icon name={m.icon} className="size-4 text-ink-faint" />
                      <span>
                        <span className="block text-sm font-medium text-ink">{m.label}</span>
                        <span className="block text-xs text-ink-faint">{m.hint}</span>
                      </span>
                    </label>
                  ))}
                  {canScreen ? null : (
                    <p className="mt-2 text-xs text-ink-faint" data-testid="clip-no-screen">
                      This device can’t record its screen from a browser. For screen recordings, use
                      Chrome or Edge on a computer.
                    </p>
                  )}
                </fieldset>

                {wantsCamera ? (
                  <DeviceSelect
                    label="Camera"
                    testId="clip-camera"
                    devices={devices.cameras}
                    value={cameraId ?? camera?.getVideoTracks()[0]?.getSettings().deviceId ?? ''}
                    onChange={setCameraId}
                    disabled={locked}
                  />
                ) : null}
                <DeviceSelect
                  label="Microphone"
                  testId="clip-mic"
                  devices={devices.mics}
                  value={micId ?? mic?.getAudioTracks()[0]?.getSettings().deviceId ?? ''}
                  onChange={setMicId}
                  disabled={locked}
                  none="No microphone"
                >
                  {micId !== NO_MIC ? <MicMeter stream={mic} testId="setup-mic-level" /> : null}
                </DeviceSelect>

                {deviceError ? (
                  <p className="text-sm text-ember" role="alert">
                    {deviceError}
                  </p>
                ) : null}
                {state?.error ? (
                  <p className="text-sm text-ember" role="alert" data-testid="recorder-error">
                    {state.error}
                  </p>
                ) : null}
                {available === false ? (
                  <p className="text-sm text-ember" role="alert">
                    Clips needs video storage, which isn’t set up on this {product()} yet.
                  </p>
                ) : unsupported ? (
                  <p className="text-sm text-ember" role="alert">
                    Recording needs Chrome or Edge on a computer.
                  </p>
                ) : null}

                <button
                  type="button"
                  className={`${primaryButton} h-12 text-base`}
                  onClick={start}
                  disabled={locked || unsupported || needsCamera || available === false}
                  data-testid="clip-start"
                >
                  <span className="size-3 rounded-full bg-paper-raised" aria-hidden="true" />
                  {phase === 'starting' ? 'Choose what to share…' : 'Start recording'}
                </button>
                {mode !== 'camera' ? (
                  <p className="text-xs leading-relaxed text-ink-faint">
                    Chrome asks what to share.{' '}
                    {mode === 'screen_camera'
                      ? 'Share your screen, a window or a tab: your camera bubble goes into the video either way. '
                      : ''}
                    On a Mac, Chrome needs Screen Recording permission (System Settings → Privacy
                    &amp; Security) the first time.
                  </p>
                ) : null}
              </>
            ) : null}

            {active && state ? (
              <RecordingStatus
                state={state}
                mic={micId === NO_MIC ? null : mic}
                camera={wantsCamera ? camera : null}
              />
            ) : null}
            {active ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className={`${primaryButton} h-12 text-base`}
                  onClick={() => void session?.stop()}
                  data-testid="clip-stop"
                >
                  <Icon name="stop" />
                  {phase === 'countdown' ? 'Cancel' : 'Stop and save'}
                </button>
                {phase !== 'countdown' ? (
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => (phase === 'paused' ? session?.resume() : session?.pause())}
                      data-testid="clip-pause"
                    >
                      <Icon name={phase === 'paused' ? 'play' : 'pause'} />
                      {phase === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => void session?.restart()}
                      data-testid="clip-restart"
                    >
                      <Icon name="restart" />
                      Restart
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => session?.cancel()}
                      data-testid="clip-cancel"
                    >
                      <Icon name="trash" />
                      Discard
                    </button>
                  </div>
                ) : null}
                <UploadLine
                  behindBytes={behindBytes}
                  retrying={upload?.retrying ?? false}
                  remainingMs={MAX_RECORDING_MS - elapsed}
                />
              </div>
            ) : null}

            {phase === 'finishing' ? (
              <div
                className="rounded-xl border border-ash bg-paper-raised p-4"
                data-testid="clip-finishing"
              >
                {state?.error ? (
                  <>
                    <p className="text-sm text-ember" role="alert">
                      {state.error}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className={primaryButton}
                        onClick={() => void session?.retryFinish()}
                      >
                        Try again
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => session?.discardUnsaved()}
                      >
                        Discard
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="flex items-center gap-2 text-sm text-ink">
                      <span className="clip-spinner clip-spinner--small" aria-hidden="true" />
                      Saving your clip…
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {behindBytes > 0
                        ? `Sending the last ${formatBytes(behindBytes)}${upload?.retrying ? ' (waiting for the connection)' : ''}.`
                        : 'Almost there.'}
                    </p>
                  </>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      {active && mode === 'screen_camera' && !state?.pipWindow && session ? (
        <div className="clip-page-bubble">
          <BubbleView session={session} camera={camera} mic={null} inPage />
        </div>
      ) : null}

      {blocker.state === 'blocked' ? (
        <Dialog title="You’re still recording" onClose={() => blocker.reset()}>
          <p className="text-sm text-ink-soft">
            Leaving this page throws the recording away. Stop it first to save it.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => blocker.reset()}>
              Keep recording
            </button>
            <button
              type="button"
              className={primaryButton}
              onClick={() => {
                session?.cancel()
                blocker.proceed()
              }}
            >
              Discard and leave
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

const noopSubscribe = () => () => {}
const nullSnapshot = () => null

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function UploadLine({
  behindBytes,
  retrying,
  remainingMs,
}: {
  behindBytes: number
  retrying: boolean
  remainingMs: number
}) {
  return (
    <p className="mt-1 text-xs text-ink-faint" data-testid="clip-upload">
      {retrying
        ? `The connection dropped. ${formatBytes(behindBytes)} will send when it’s back; nothing is lost.`
        : behindBytes > 512 * 1024
          ? `Uploading as you go (${formatBytes(behindBytes)} to send).`
          : 'Uploading as you go, so it’s ready the moment you stop.'}
      {remainingMs < 5 * 60_000 ? ` Stops by itself in ${formatDuration(remainingMs)}.` : ''}
    </p>
  )
}

function PreviewCamera({ stream, large }: { stream: MediaStream | null; large: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return (
    <div
      className={large ? 'clip-preview__cam-large' : 'clip-preview__cam'}
      data-testid="camera-preview"
    >
      {stream ? (
        <video ref={ref} autoPlay muted playsInline />
      ) : (
        <Icon name="video" className="size-6" />
      )}
    </div>
  )
}

function DeviceSelect({
  label,
  testId,
  devices,
  value,
  onChange,
  disabled,
  none,
  children,
}: {
  label: string
  testId: string
  devices: MediaDeviceInfo[]
  value: string
  onChange: (id: string) => void
  disabled: boolean
  none?: string
  children?: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        className="h-10 rounded-lg border border-ash bg-paper-raised px-2.5 text-sm text-ink hover:border-ash-strong disabled:opacity-60"
      >
        {devices.length === 0 && value !== NO_MIC ? <option value={value}>Default</option> : null}
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
        {none ? <option value={NO_MIC}>{none}</option> : null}
      </select>
      {children}
    </label>
  )
}
