// One recording, from the Start click to the clip page (ARCHITECTURE §10.3). React-free so it can
// be tested with fakes; the page and the camera bubble's window both read it through `subscribe`.

import { HearthApiError } from '../../../api/client'
import type { Clip, ClipContainer, ClipMode } from '../../../api/clips'
import {
  AUDIO_BITS,
  isDenied,
  type MixedAudio,
  mixAudio,
  type RecordingFormat,
  stopStream,
  VIDEO_BITS,
} from './media'
import { ChunkUploader, isRetryable, type UploadState } from './uploader'

/** MediaRecorder hands over a chunk this often; each is uploaded as soon as it's made. */
export const TIMESLICE_MS = 3000
export const MAX_RECORDING_MS = 60 * 60_000
export const COUNTDOWN_FROM = 3

export type Phase =
  | 'idle'
  /** The share picker is open. */
  | 'starting'
  | 'countdown'
  | 'recording'
  | 'paused'
  /** Stopped; the last chunks are uploading and the server is told the recording is complete. */
  | 'finishing'
  | 'finished'

export interface SessionState {
  phase: Phase
  countdown: number | null
  /** Recorded time before the current stretch; add `now - runningSince` while recording. */
  recordedMs: number
  runningSince: number | null
  upload: UploadState
  /** Shown above the controls: why the last start or stop didn't work. */
  error: string | null
  /** What was shared: only `monitor` (a whole screen) shows the camera bubble in the video. */
  surface: string | null
  /** The camera bubble's always-on-top window, while it's open. */
  pipWindow: Window | null
  clip: Clip | null
}

export interface StartOptions {
  mode: ClipMode
  title: string
  camera: MediaStream | null
  mic: MediaStream | null
}

export interface SessionDeps {
  api: {
    create: (body: { mode: ClipMode; container: ClipContainer; title?: string }) => Promise<Clip>
    putChunk: (id: string, seq: number, data: Blob) => Promise<void>
    finish: (id: string, chunks: number) => Promise<Clip>
    remove: (id: string) => Promise<void>
  }
  format: RecordingFormat
  requestDisplay: () => Promise<MediaStream>
  /** The bubble's window, or null where Document Picture-in-Picture isn't available. */
  openPip: (() => Promise<Window>) | null
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder
  mix?: (sources: Array<MediaStream | null>) => MixedAudio
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const EMPTY_UPLOAD: UploadState = {
  chunks: 0,
  sent: 0,
  pendingBytes: 0,
  retrying: false,
  fatal: null,
}

export function elapsedMs(state: SessionState, now: number): number {
  return state.recordedMs + (state.runningSince === null ? 0 : now - state.runningSince)
}

export class RecordingSession {
  readonly #deps: SessionDeps
  readonly #listeners = new Set<() => void>()
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  #state: SessionState = {
    phase: 'idle',
    countdown: null,
    recordedMs: 0,
    runningSince: null,
    upload: EMPTY_UPLOAD,
    error: null,
    surface: null,
    pipWindow: null,
    clip: null,
  }
  #display: MediaStream | null = null
  #mixed: MixedAudio | null = null
  #recorder: MediaRecorder | null = null
  #uploader: ChunkUploader | null = null
  #unsubscribeUpload: (() => void) | null = null
  #recorderStopped: Promise<void> = Promise.resolve()
  /** Bumped by cancel: a start still waiting on the picker or the countdown gives up. */
  #attempt = 0
  #last: StartOptions | null = null

  constructor(deps: SessionDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => performance.now())
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  get state(): SessionState {
    return this.#state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): SessionState => this.#state

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }

  /**
   * Call straight from a click: the share picker and the bubble's window both need it. The
   * picker is asked for first, synchronously, then the window.
   */
  async start(opts: StartOptions): Promise<void> {
    if (this.#state.phase !== 'idle') return
    this.#last = opts
    const attempt = ++this.#attempt
    const displayPromise = opts.mode === 'camera' ? null : this.#deps.requestDisplay()
    const wantsPip = opts.mode !== 'camera' && this.#deps.openPip !== null
    const pipPromise = wantsPip ? (this.#deps.openPip as () => Promise<Window>)() : null
    this.#set({ phase: 'starting', error: null, countdown: null, recordedMs: 0, clip: null })
    const created = this.#deps.api.create({
      mode: opts.mode,
      container: this.#deps.format.container,
      title: opts.title,
    })

    let display: MediaStream | null = null
    let pip: Window | null = null
    let clip: Clip
    try {
      display = displayPromise ? await displayPromise : null
    } catch (err) {
      void pipPromise?.then((w) => w.close()).catch(() => {})
      void created.then((c) => this.#deps.api.remove(c.id)).catch(() => {})
      this.#set({
        phase: 'idle',
        error: isDenied(err)
          ? null
          : 'Chrome couldn’t share your screen. On a Mac, allow Chrome under System Settings → Privacy & Security → Screen Recording.',
      })
      return
    }
    pip = (await pipPromise?.catch(() => null)) ?? null
    try {
      clip = await created
    } catch (err) {
      stopStream(display)
      pip?.close()
      this.#set({ phase: 'idle', error: messageOf(err) })
      return
    }
    if (attempt !== this.#attempt) {
      stopStream(display)
      pip?.close()
      void this.#deps.api.remove(clip.id).catch(() => {})
      return
    }
    this.#display = display
    const video = (display ?? opts.camera)?.getVideoTracks()[0] ?? null
    if (!video) {
      this.#cleanup()
      pip?.close()
      void this.#deps.api.remove(clip.id).catch(() => {})
      this.#set({ phase: 'idle', error: 'There’s no camera or screen to record.' })
      return
    }
    if (pip) pip.addEventListener('pagehide', () => this.#set({ pipWindow: null }), { once: true })
    // Chrome's own "Stop sharing" ends the recording, as if Stop were pressed.
    display?.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop())
    this.#set({
      clip,
      pipWindow: pip,
      surface:
        (display?.getVideoTracks()[0]?.getSettings() as { displaySurface?: string })
          ?.displaySurface ?? null,
    })

    for (let n = COUNTDOWN_FROM; n > 0; n--) {
      this.#set({ phase: 'countdown', countdown: n })
      await this.#sleep(1000)
      if (attempt !== this.#attempt) return
    }

    const mixed = (this.#deps.mix ?? mixAudio)([opts.mic, display])
    this.#mixed = mixed
    const stream = new MediaStream(mixed.track ? [video, mixed.track] : [video])
    const uploader = new ChunkUploader((seq, data) => this.#deps.api.putChunk(clip.id, seq, data))
    this.#uploader = uploader
    this.#unsubscribeUpload = uploader.subscribe((upload) => this.#set({ upload }))
    const recorder = this.#deps.createRecorder(stream, {
      mimeType: this.#deps.format.mimeType,
      videoBitsPerSecond: VIDEO_BITS,
      audioBitsPerSecond: AUDIO_BITS,
    })
    this.#recorder = recorder
    this.#recorderStopped = new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
    })
    recorder.addEventListener('dataavailable', (event) => {
      if (attempt !== this.#attempt) return
      uploader.add(event.data)
      if (elapsedMs(this.#state, this.#now()) >= MAX_RECORDING_MS) void this.stop()
    })
    recorder.start(TIMESLICE_MS)
    this.#set({ phase: 'recording', countdown: null, runningSince: this.#now() })
  }

  pause(): void {
    if (this.#state.phase !== 'recording' || !this.#recorder) return
    this.#recorder.pause()
    this.#set({
      phase: 'paused',
      recordedMs: elapsedMs(this.#state, this.#now()),
      runningSince: null,
    })
  }

  resume(): void {
    if (this.#state.phase !== 'paused' || !this.#recorder) return
    this.#recorder.resume()
    this.#set({ phase: 'recording', runningSince: this.#now() })
  }

  /** Ends the recording, waits for every chunk to reach the server, and finishes the clip. */
  async stop(): Promise<void> {
    const { phase, clip } = this.#state
    if (phase === 'countdown' || phase === 'starting') return this.cancel()
    if ((phase !== 'recording' && phase !== 'paused') || !clip || !this.#recorder) return
    this.#set({
      phase: 'finishing',
      recordedMs: elapsedMs(this.#state, this.#now()),
      runningSince: null,
    })
    if (this.#recorder.state !== 'inactive') this.#recorder.stop()
    await this.#recorderStopped
    this.#releaseCapture()
    await this.#finish(clip)
  }

  /**
   * Waits out the upload and tells the server. A connection problem leaves the phase at
   * `finishing` with the error, for `retryFinish`; anything retrying can't fix (nothing
   * recorded, the clip refused or gone) discards the recording and says why.
   */
  async #finish(clip: Clip): Promise<void> {
    const uploader = this.#uploader
    const attempt = this.#attempt
    try {
      await uploader?.drain()
      const chunks = uploader?.state.chunks ?? 0
      if (chunks === 0) throw new Unrecoverable('Nothing was recorded. Try again.')
      let tries = 0
      for (;;) {
        try {
          const done = await this.#deps.api.finish(clip.id, chunks)
          if (attempt === this.#attempt) this.#set({ phase: 'finished', clip: done, error: null })
          return
        } catch (err) {
          if (!isRetryable(err) || ++tries >= 5) throw err
          await this.#sleep(1000 * 2 ** tries)
        }
      }
    } catch (err) {
      if (attempt !== this.#attempt) return
      if (err instanceof Unrecoverable || !isRetryable(err)) {
        this.#discard(`The recording couldn’t be saved: ${messageOf(err)}`)
      } else {
        this.#set({ error: messageOf(err) })
      }
    }
  }

  retryFinish(): Promise<void> {
    const { phase, clip } = this.#state
    if (phase !== 'finishing' || !clip) return Promise.resolve()
    return this.#finish(clip)
  }

  /**
   * Throws the recording away: nothing is kept on the server. Not once Stop was pressed: that
   * recording is being saved (`discardUnsaved` gives up on a save that can't finish).
   */
  cancel(): void {
    if (this.#state.phase === 'finishing' || this.#state.phase === 'finished') return
    this.#discard(null)
  }

  /** Gives up on a recording whose save failed: deletes it, back to the start. */
  discardUnsaved(): void {
    if (this.#state.phase !== 'finishing') return
    this.#discard(null)
  }

  #discard(error: string | null): void {
    this.#attempt++
    const clip = this.#state.clip
    this.#uploader?.stop()
    if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop()
    this.#cleanup()
    if (clip) void this.#deps.api.remove(clip.id).catch(() => {})
    this.#set({
      phase: 'idle',
      countdown: null,
      recordedMs: 0,
      runningSince: null,
      upload: EMPTY_UPLOAD,
      clip: null,
      surface: null,
      error,
    })
  }

  /** Cancel, then start again with the same choices. Call from a click, like `start`. */
  restart(): Promise<void> {
    const last = this.#last
    this.cancel()
    return last ? this.start(last) : Promise.resolve()
  }

  /** The page is going away: stop capturing, without deleting a clip that's being finished. */
  dispose(): void {
    if (this.#state.phase === 'finishing' || this.#state.phase === 'finished') {
      this.#releaseCapture()
      return
    }
    this.cancel()
  }

  #releaseCapture(): void {
    stopStream(this.#display)
    this.#display = null
    this.#mixed?.close()
    this.#mixed = null
    this.#state.pipWindow?.close()
    if (this.#state.pipWindow) this.#set({ pipWindow: null })
  }

  #cleanup(): void {
    this.#unsubscribeUpload?.()
    this.#unsubscribeUpload = null
    this.#releaseCapture()
    this.#recorder = null
    this.#uploader = null
  }
}

/** A save that retrying won't fix. */
class Unrecoverable extends Error {}

function messageOf(err: unknown): string {
  if (err instanceof HearthApiError || err instanceof Error) return err.message
  return 'Something went wrong'
}
