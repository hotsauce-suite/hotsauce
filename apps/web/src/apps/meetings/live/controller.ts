// The meeting being recorded. Module-level, like the docs socket, so recording carries on
// while the member looks something up in Docs; the live page and the chrome only observe it.

import { HearthApiError } from '../../../api/client'
import { meetingsApi } from '../../../api/meetings'
import type { MeetingSession, MeetingState, StopResult } from '../../../api/types'
import { product } from '../../../brand/product'
import type { Capture } from '../audio/capture'
import type { Recorder } from '../audio/recorder'
import { AudioRing } from '../audio/ring-buffer'
import { forgetSkipped, MeetingSocket } from '../audio/socket'
import { getLive, type LiveSnapshot, patchLive, setLive } from './liveState'

/** Raw notes reach the server this long after typing stops (ARCHITECTURE §7.3, `notes`). */
export const NOTES_DEBOUNCE_MS = 500
/** A Keep audio choice the server didn't get is sent again after 3, 6 and 9 seconds. */
const KEEP_AUDIO_RETRY_MS = 3_000
/** How long Stop waits for unsent audio to reach the server. */
const STOP_FLUSH_MS = 10_000
export const unsentAudio = () =>
  `The last part of the audio hasn’t reached ${product()} yet. Check your connection and press Stop again; if it still can’t get through, that press saves the meeting without it.`
const KEEP_AUDIO_RETRIES = 3

const DRAFT_PREFIX = 'hearth.meeting-notes:'

export function notesDraftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`
}

/** The notes typed on this device for a session, kept until the meeting is stopped. */
export function readNotesDraft(sessionId: string): string | null {
  try {
    return localStorage.getItem(notesDraftKey(sessionId))
  } catch {
    return null
  }
}

function writeNotesDraft(sessionId: string, text: string | null): void {
  try {
    if (text === null) localStorage.removeItem(notesDraftKey(sessionId))
    else localStorage.setItem(notesDraftKey(sessionId), text)
  } catch {
    // Best-effort: the server has the notes too.
  }
}

export interface LiveMeetingOptions {
  ring?: AudioRing
  /** Overrides the socket's reconnect delay (tests). */
  minBackoffMs?: number
  /** Overrides how long Stop waits for unsent audio (tests). */
  stopFlushMs?: number
}

export class LiveMeeting {
  readonly session: MeetingSession
  readonly socket: MeetingSocket
  private readonly ring: AudioRing
  private capture: Capture | null = null
  private recorder: Recorder | null = null
  /** The notepad's latest text, once typed on this page. */
  private text: string | null = null
  /** Typed but not yet known to be on the server. */
  private notes: string | null = null
  private notesTimer: ReturnType<typeof setTimeout> | null = null
  private wakeLock: WakeLockSentinel | null = null
  private readonly cleanups: Array<() => void> = []
  private disposed = false
  /** Counts attachCapture calls, so a slower, older one knows it was replaced. */
  private attachments = 0
  /** This page's Stop is under way: the server's `stopped` is its own, not another device's. */
  private stopping = false
  /** A Stop already said audio was unsent; the next one saves without it. */
  private stopWithoutUnsent = false
  private readonly stopFlushMs: number
  /** What the member last chose; re-sent after every `ready` (ARCHITECTURE §7.3). */
  private intent: 'recording' | 'paused'
  /** The intent went out (or couldn't) and no `state` has confirmed it yet. */
  private intentPending = false
  /** Set when the server ended the meeting while this page had it open (stopped elsewhere). */
  endedElsewhere: string | null = null
  /** The member's Keep audio choice; undefined until they make one (the server's default). */
  keepAudio: boolean | undefined
  private keepAudioSending = false

  constructor(session: MeetingSession, opts: LiveMeetingOptions = {}) {
    this.session = session
    this.keepAudio = session.keepAudio
    this.ring = opts.ring ?? new AudioRing()
    this.stopFlushMs = opts.stopFlushMs ?? STOP_FLUSH_MS
    this.intent = session.state === 'paused' ? 'paused' : 'recording'
    this.socket = new MeetingSocket({
      sessionId: session.id,
      ring: this.ring,
      ...(opts.minBackoffMs !== undefined ? { minBackoffMs: opts.minBackoffMs } : {}),
    })
    this.socket.seedTranscript(session.segments)
    setLive({
      id: session.id,
      title: session.title,
      startedAt: session.startedAt,
      state: session.state,
      link: 'connecting',
      capturing: false,
      lostTrack: null,
      error: null,
    })
    this.cleanups.push(
      // Whatever happened while the socket was down, the member's last choice stands.
      this.socket.on('ready', () => {
        this.intentPending = true
        this.socket.send({ type: this.intent === 'paused' ? 'pause' : 'resume' })
      }),
      this.socket.on('state', (state) => this.onState(state)),
      this.socket.on('error', (error) => this.patch({ error })),
      this.socket.on('status', (link) => {
        this.patch({ link })
        // The socket gave up for good (not the owner, no such session, signed out).
        if (link === 'closed' && !this.stopping) {
          void this.endElsewhere(this.snapshot?.error ?? 'This meeting can’t be reached any more.')
        }
      }),
    )
    // After a reload, notes typed here that the server never got are in the draft.
    const draft = readNotesDraft(session.id)
    if (draft !== null && draft !== session.rawNotes) this.setNotes(draft)
    // Leaving or hiding the page writes the notes out now rather than after the debounce.
    const onHide = () => {
      // A failed send keeps the notes pending (and in the draft) for the next try.
      if (document.visibilityState === 'hidden') {
        void this.flushNotes({ keepalive: true }).catch(() => {})
      } else void this.keepScreenOn()
    }
    document.addEventListener('visibilitychange', onHide)
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onHide))
    // Closing the tab would quietly stop the audio for the rest of the meeting; ask first.
    // A reload is fine: the page reattaches and resends what the ring buffer kept.
    const onUnload = (event: BeforeUnloadEvent) => {
      void this.flushNotes({ keepalive: true }).catch(() => {})
      if (this.capture && this.snapshot?.state === 'recording') event.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    this.cleanups.push(() => window.removeEventListener('beforeunload', onUnload))
    this.socket.start()
  }

  get snapshot(): LiveSnapshot | null {
    const live = getLive()
    return live?.id === this.session.id ? live : null
  }

  /** Updates the chrome's state, if it still describes this meeting. */
  private patch(next: Partial<LiveSnapshot>): void {
    if (this.snapshot) patchLive(next)
  }

  /**
   * Starts sending audio from `capture`; replaces any earlier capture (a re-shared tab). An
   * attach overtaken by a newer one, or by dispose(), releases what it started.
   */
  async attachCapture(capture: Capture): Promise<void> {
    this.attachments += 1
    const attempt = this.attachments
    const replaced = () => this.disposed || attempt !== this.attachments
    await this.releaseCapture()
    if (replaced()) {
      capture.stop()
      return
    }
    this.capture = capture
    capture.onEnded((track) => this.patch({ lostTrack: track }))
    const { startRecorder } = await import('../audio/recorder')
    if (replaced()) {
      capture.stop()
      return
    }
    const recorder = await startRecorder(capture, (track, pcm) => this.socket.sendAudio(track, pcm))
    if (replaced()) {
      capture.stop()
      await recorder.stop()
      return
    }
    this.recorder = recorder
    recorder.setPaused(this.snapshot?.state !== 'recording')
    this.patch({ capturing: true, lostTrack: null })
    void this.keepScreenOn()
  }

  /** What the notepad should show: typed here, else this device's draft, else the server's. */
  get notesText(): string {
    return this.text ?? readNotesDraft(this.session.id) ?? this.session.rawNotes
  }

  /** The notepad changed: keep a local draft and send the text once typing pauses. */
  setNotes(text: string): void {
    this.text = text
    this.notes = text
    if (this.notesTimer) clearTimeout(this.notesTimer)
    this.notesTimer = setTimeout(() => {
      this.notesTimer = null
      this.syncNotes()
    }, NOTES_DEBOUNCE_MS)
  }

  private syncNotes(): void {
    const text = this.notes
    if (text === null) return
    writeNotesDraft(this.session.id, text)
    if (this.socket.send({ type: 'notes', text })) {
      this.notes = null
      return
    }
    meetingsApi.putNotes(this.session.id, text).then(
      () => {
        if (this.notes === text) this.notes = null
      },
      () => {
        // Kept in `notes` and the draft; the next change or Stop sends it.
      },
    )
  }

  /** Sends unsent notes over HTTP and waits for the server to have them. */
  async flushNotes(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.notesTimer) clearTimeout(this.notesTimer)
    this.notesTimer = null
    const text = this.notes
    if (text === null) return
    writeNotesDraft(this.session.id, text)
    await meetingsApi.putNotes(this.session.id, text, opts)
    if (this.notes === text) this.notes = null
  }

  pause(): Promise<void> {
    return this.choose('paused')
  }

  resume(): Promise<void> {
    return this.choose('recording')
  }

  /**
   * The member's choice holds on this page at once, whatever the network does: the recorder
   * follows it now, and the server hears it over the socket, else over HTTP, else after the
   * next `ready`.
   */
  private async choose(intent: 'recording' | 'paused'): Promise<void> {
    this.intent = intent
    this.intentPending = true
    this.recorder?.setPaused(intent === 'paused')
    this.patch({ state: intent })
    if (this.socket.send({ type: intent === 'paused' ? 'pause' : 'resume' })) return
    try {
      if (intent === 'paused') await meetingsApi.pause(this.session.id)
      else await meetingsApi.resume(this.session.id)
    } catch {
      // The next `ready` sends it again.
    }
  }

  /**
   * The server's state. A pause or resume that contradicts a choice still on its way is stale
   * (that choice's own state follows), so it moves nothing. Any other state moves the recorder
   * and the chrome, a stop included.
   */
  private onState(state: MeetingState): void {
    if (state === 'recording' || state === 'paused') {
      if (this.intentPending && state !== this.intent) return
      this.intent = state
      this.intentPending = false
    }
    this.recorder?.setPaused(state !== 'recording')
    this.patch({ state })
    if ((state === 'stopped' || state === 'saved') && !this.stopping) {
      void this.endElsewhere(
        state === 'saved'
          ? 'This meeting was stopped elsewhere and its notes are saved.'
          : `This meeting was stopped elsewhere: from another device, or by ${product()} after a long idle. Its notes are being saved; if it still shows as unsaved on your meetings list, press Save it now.`,
      )
    }
  }

  /**
   * Keep audio, on this page and on the server, so the choice holds however the meeting ends:
   * Stop in another tab, Save it now, or the server saving it after a long idle. One request at
   * a time, always the latest choice, tried again a few times if the server can't be reached.
   * Stop on this page sends it too.
   */
  setKeepAudio(keep: boolean): void {
    this.keepAudio = keep
    void this.sendKeepAudio(0)
  }

  private async sendKeepAudio(attempt: number): Promise<void> {
    const keep = this.keepAudio
    if (this.keepAudioSending || this.disposed || this.stopping || keep === undefined) return
    this.keepAudioSending = true
    let failed = false
    try {
      await meetingsApi.setKeepAudio(this.session.id, keep)
    } catch (err) {
      // A 4xx (stopped meanwhile, or refused) won't change by asking again; no answer (status 0)
      // or a 5xx might.
      const status = err instanceof HearthApiError ? err.status : 0
      failed = status === 0 || status >= 500
    }
    this.keepAudioSending = false
    if (this.keepAudio !== keep) void this.sendKeepAudio(0)
    else if (failed && attempt < KEEP_AUDIO_RETRIES) {
      setTimeout(() => void this.sendKeepAudio(attempt + 1), KEEP_AUDIO_RETRY_MS * (attempt + 1))
    }
  }

  /**
   * Notes first (Stop must not lose the last few words), then stop on the server, which
   * commits the note and transcript. On failure nothing is torn down (the ring keeps the
   * audio), so Stop can be retried, even once the server says `stopped`.
   */
  async stop(opts: { keepAudio?: boolean } = {}): Promise<StopResult> {
    if (this.notesTimer) clearTimeout(this.notesTimer)
    this.notesTimer = null
    this.stopping = true
    let result: StopResult
    try {
      // Unsent notes go out now as a `notes` frame, as the debounce would have sent them.
      // The stop request carries the notepad's text too, and that copy is the one the server
      // saves: a frame may still be queued behind audio, and after a reload this device's
      // draft can be newer than the server's copy.
      const text = this.notesText
      writeNotesDraft(this.session.id, text)
      if (this.notes !== null && this.socket.send({ type: 'notes', text })) this.notes = null
      const keepAudio = opts.keepAudio ?? this.keepAudio
      // Audio still queued, or being resent after a reconnect, must reach the server before it
      // saves; otherwise the meeting's last seconds are missing. If it can't get there, the first
      // Stop says so and keeps everything; pressing Stop again saves without it.
      if (!(await this.socket.flushed(this.stopFlushMs)) && !this.stopWithoutUnsent) {
        this.stopWithoutUnsent = true
        throw new Error(unsentAudio())
      }
      result = await meetingsApi.stop(this.session.id, {
        ...(keepAudio === undefined ? {} : { keepAudio }),
        notes: text,
      })
    } catch (err) {
      this.stopping = false
      throw err
    }
    await this.dispose()
    void this.ring.clear(this.session.id)
    forgetSkipped(this.session.id)
    writeNotesDraft(this.session.id, null)
    return result
  }

  /** Stops everything on this page without ending the meeting on the server. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.notesTimer) clearTimeout(this.notesTimer)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.socket.stop()
    await this.releaseCapture()
    void this.wakeLock?.release().catch(() => {})
    this.wakeLock = null
    if (getLive()?.id === this.session.id) setLive(null)
    if (current === this) current = null
  }

  /**
   * The server ended the meeting (stopped on another device, or the session is gone): let go
   * of the microphone and the tab, and of the audio kept for resending. The notepad's text
   * stays in this device's draft.
   */
  private async endElsewhere(reason: string): Promise<void> {
    if (this.disposed) return
    this.endedElsewhere = reason
    await this.dispose()
    void this.ring.clear(this.session.id)
    forgetSkipped(this.session.id)
  }

  private async releaseCapture(): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    this.capture?.stop()
    this.capture = null
    await recorder?.stop()
  }

  /** Phones: in-person capture only works with the screen on (PRD §4), so keep it on. */
  private async keepScreenOn(): Promise<void> {
    if (this.disposed || !this.capture || this.wakeLock || !('wakeLock' in navigator)) return
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      this.wakeLock = sentinel
      sentinel.addEventListener('release', () => {
        if (this.wakeLock === sentinel) this.wakeLock = null
      })
    } catch {
      // Denied or unsupported; the meeting still records while the screen is on.
    }
  }
}

let current: LiveMeeting | null = null

export function currentLive(): LiveMeeting | null {
  return current
}

/** Makes `session` the meeting being recorded on this page. */
export function beginLive(session: MeetingSession, opts: LiveMeetingOptions = {}): LiveMeeting {
  if (current && current.session.id !== session.id) void current.dispose()
  if (current?.session.id === session.id) return current
  current = new LiveMeeting(session, opts)
  return current
}

/**
 * Stops a meeting and saves it: through this page's controller when this page is recording
 * it, else directly (a meeting found `stopped` after a failed save, or one recording in another
 * tab), with this device's notes draft. Once it's saved, the draft and the kept audio go.
 */
export async function stopSession(id: string): Promise<StopResult> {
  if (current?.session.id === id) return current.stop()
  const notes = readNotesDraft(id)
  const result = await meetingsApi.stop(id, notes === null ? {} : { notes })
  writeNotesDraft(id, null)
  void new AudioRing().clear(id)
  forgetSkipped(id)
  return result
}
