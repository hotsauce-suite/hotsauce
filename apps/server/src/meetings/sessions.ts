import type { WriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { newId, parseFrontmatter } from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import { KeyedMutex } from '../git/mutex.js'
import type { SpaceService } from '../spaces/index.js'
import { type AudioStore, pcmSeconds, WAV_HEADER_BYTES, wavStream } from './audio/index.js'
import { type CalendarSource, findEvent } from './calendar/types.js'
import {
  attendeeLabel,
  type CaptureInput,
  type CapturePaths,
  captureFiles,
  capturePaths,
  externalDomains,
  keptAudioKey,
  keptAudioPath,
  keptAudioPointer,
} from './files.js'
import { parseAudioFrame } from './frames.js'
import {
  type RecoveredSession,
  type SavedMeeting,
  type SessionMeta,
  type SessionState,
  SessionStore,
} from './session-store.js'
import { DEFAULT_TEMPLATE, type MeetingTemplates } from './templates.js'
import {
  PCM_BYTES_PER_MS,
  TRACKS,
  type Track,
  type Transcriber,
  type TranscriberSession,
  type TranscriptSegment,
} from './transcriber/types.js'
import { assertTimeZone, clockTimeIn } from './zoned-time.js'

export type { SavedMeeting, SessionState } from './session-store.js'

export interface MeetingSession {
  id: string
  /** The owner's email. */
  owner: string
  space: string
  title: string
  template: string
  calendarEventId?: string
  /** The Google Meet call it records ("abc-defg-hij"), when the client said. */
  meetCode?: string
  startedAt: string
  state: SessionState
  /** The member's Keep audio choice, once made; otherwise Stop uses the server's default. */
  keepAudio?: boolean
  rawNotes: string
  /** Final segments so far. */
  segments: TranscriptSegment[]
  /** Where the meeting was committed, once `state` is `saved`. */
  saved?: SavedMeeting
}

/** Server-to-client messages on `/ws/meetings/:id` (ARCHITECTURE §7.3). */
export type ServerMessage =
  | { type: 'ready'; sessionId: string; resumeFrom: Record<Track, number> }
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'state'; state: SessionState }
  | { type: 'error'; message: string }

/** The one socket a session streams to. A newer one replaces it. */
export interface AudioSocket {
  send(message: ServerMessage): void
  close(code: number, reason: string): void
}

export interface AudioConnection {
  /** Bytes the server holds per track; the client resends from there. */
  resumeFrom: Record<Track, number>
  /** A binary frame: byte 0 is the track (0 me, 1 them), the rest PCM16 LE 16 kHz mono. */
  audio(frame: Uint8Array): void
  detach(): void
}

/** Close code for a socket replaced by the same session's newer connection. */
export const WS_REPLACED = 4409

// A dropped connection keeps its transcriber this long, so a quick reconnect continues it.
const DETACH_GRACE_MS = 60_000
// SESSION_IDLE_STOP_MINUTES and SESSION_MAX_HOURS defaults, and how often they're checked.
const IDLE_STOP_MS = 120 * 60_000
const MAX_AGE_MS = 8 * 60 * 60_000
const SWEEP_INTERVAL_MS = 60_000
/** A failed kept-audio upload is tried again this much later, by the sweep. */
const AUDIO_RETRY_MS = 10 * 60_000
/** At shutdown, uploads in flight get this long to finish (fly.toml kill_timeout is longer). */
const SHUTDOWN_UPLOAD_WAIT_MS = 20_000
/** Meetings one member can have recording or paused at once. */
export const MAX_OPEN_SESSIONS = 3
/**
 * Audio a track may hold: real time since the meeting started, plus slack for clock skew and a
 * replayed buffer. More than this isn't a microphone; it would fill the volume and the ASR bill.
 */
const AUDIO_SLACK_MS = 10 * 60_000

interface Live {
  meta: SessionMeta
  bytes: Record<Track, number>
  /** Audio beyond real time was dropped (and the client told once). */
  overCap?: boolean
  segments: TranscriptSegment[]
  audio: Partial<Record<Track, WriteStream>>
  transcriber: TranscriberSession | null
  transcriberStarting: Promise<void> | null
  socket: AudioSocket | null
  /** Since when (ms since the epoch) no socket has been attached, while `socket` is null. */
  idleSince: number
  idleTimer: ReturnType<typeof setTimeout> | null
  stopping: Promise<SavedMeeting> | null
}

export interface MeetingSessionsOptions {
  dataDir: string
  git: Pick<GitStore, 'commit' | 'readFile'>
  /** Index and announce a commit (Syncer.afterHeadChanged). */
  afterCommit: (space: string) => Promise<void>
  transcriber: Transcriber
  templates: Pick<MeetingTemplates, 'getTemplate'>
  calendar: CalendarSource
  spaces: Pick<SpaceService, 'visibleSpaces'>
  /** Email domains of the company itself; the others become the note's `companies`. */
  internalDomains: readonly string[]
  /** KEEP_AUDIO: keep the audio after a save unless the stop request says otherwise. */
  keepAudio: boolean
  /** Where kept audio goes (AUDIO_STORE); null when keeping it isn't offered. */
  audioStore?: AudioStore | null
  /** SESSION_IDLE_STOP_MINUTES: a session with no socket for longer is stopped and saved. */
  idleStopMs?: number
  /** SESSION_MAX_HOURS: a session older than this is stopped and saved, connected or not. */
  maxAgeMs?: number
  now?: () => Date
  detachGraceMs?: number
  log?: (message: string) => void
}

/**
 * Meetings being recorded: in memory, and on disk (SessionStore) so a restart loses nothing.
 * Audio streams in over one WebSocket per session, is appended to the track's PCM file and fed to
 * the transcriber; `stop()` commits the note, transcript and raw notes to the owner's personal
 * space, authored by the owner.
 */
export class MeetingSessions {
  readonly #store: SessionStore
  readonly #opts: MeetingSessionsOptions
  readonly #now: () => Date
  readonly #log: (message: string) => void
  readonly #sessions = new Map<string, Live>()
  // Choosing free paths and committing is one step per space, so two meetings with the same title
  // stopped together don't both pick the same file.
  readonly #saves = new KeyedMutex()
  #sweeper: ReturnType<typeof setInterval> | null = null
  readonly #background = new Set<Promise<void>>()
  /** Sessions being created per owner, counted toward MAX_OPEN_SESSIONS until they exist. */
  readonly #creating = new Map<string, number>()
  /** Final segments being appended to disk; shutdown waits for them. */
  readonly #segmentWrites = new Set<Promise<void>>()
  /** Saved sessions whose kept audio hasn't uploaded yet, and when to try again (ms). */
  readonly #pendingAudio = new Map<string, { meta: SessionMeta; retryAt: number }>()
  readonly #uploading = new Set<string>()

  constructor(opts: MeetingSessionsOptions) {
    this.#opts = opts
    this.#store = new SessionStore(opts.dataDir)
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? console.error
  }

  /**
   * At startup: loads the sessions a previous process left unsaved, saves those abandoned since
   * (see `sweep`), and from then on sweeps every minute until `close()`. Returns how many it loaded.
   */
  async recover(): Promise<number> {
    const recovered = await this.#store.loadUnsaved(this.#log)
    for (const r of recovered) this.#sessions.set(r.meta.id, this.#live(r))
    // Uploads a previous process didn't finish (a deploy mid-upload, R2 down) start again.
    for (const meta of await this.#store.loadPendingAudio(this.#log)) {
      this.#pendingAudio.set(meta.id, { meta, retryAt: 0 })
    }
    await this.sweep()
    if (!this.#sweeper) {
      this.#sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
      this.#sweeper.unref()
    }
    return recovered.length
  }

  /**
   * Stops and saves, exactly as the owner's Stop would, every session that has had no socket for
   * longer than the idle limit or is older than the maximum (connected or not), so a tab that
   * died never records forever or holds a paid transcriber open. A failure is logged and the
   * next sweep tries again.
   */
  async sweep(): Promise<void> {
    const now = this.#now().getTime()
    for (const [id, pending] of this.#pendingAudio) {
      if (pending.retryAt <= now) this.#uploadKeptAudio(id)
    }
    const maxAge = this.#opts.maxAgeMs ?? MAX_AGE_MS
    const idleStop = this.#opts.idleStopMs ?? IDLE_STOP_MS
    for (const live of [...this.#sessions.values()]) {
      if (live.meta.state === 'saved') continue
      const tooOld = now - Date.parse(live.meta.startedAt) > maxAge
      const idle = live.socket === null && now - live.idleSince > idleStop
      if (!tooOld && !idle) continue
      try {
        await this.stop(live.meta.id)
        this.#log(`meeting ${live.meta.id}: saved by the server (${tooOld ? 'too long' : 'idle'})`)
      } catch (err) {
        this.#log(`meeting ${live.meta.id}: saving an abandoned session failed: ${err}`)
      }
    }
  }

  async create(
    principal: Principal,
    input: {
      title?: string
      template?: string
      calendarEventId?: string
      meetCode?: string
      tz?: string
    },
  ): Promise<MeetingSession> {
    const space = (await this.#opts.spaces.visibleSpaces(principal)).find(
      (s) => s.kind === 'personal',
    )
    if (!space) {
      throw new HearthError(
        'forbidden',
        "Your personal space isn't available right now, so there's nowhere to save a meeting",
      )
    }
    // Counted and reserved before the first await, so parallel requests can't all pass.
    const owner = principal.email.toLowerCase()
    const open =
      [...this.#sessions.values()].filter(
        (l) =>
          l.meta.owner === owner && (l.meta.state === 'recording' || l.meta.state === 'paused'),
      ).length + (this.#creating.get(owner) ?? 0)
    if (open >= MAX_OPEN_SESSIONS) {
      throw new HearthError(
        'conflict',
        `You already have ${open} meetings open (recording or paused). Stop one before starting another.`,
      )
    }
    this.#creating.set(owner, (this.#creating.get(owner) ?? 0) + 1)
    try {
      return await this.#create(principal, input, space)
    } finally {
      const left = (this.#creating.get(owner) ?? 1) - 1
      if (left > 0) this.#creating.set(owner, left)
      else this.#creating.delete(owner)
    }
  }

  async #create(
    principal: Principal,
    input: {
      title?: string
      template?: string
      calendarEventId?: string
      meetCode?: string
      tz?: string
    },
    space: { name: string },
  ): Promise<MeetingSession> {
    const tz = input.tz ?? 'UTC'
    assertTimeZone(tz)
    const template = await this.#opts.templates.getTemplate(
      principal,
      input.template ?? DEFAULT_TEMPLATE,
    )
    const now = this.#now()
    const event = input.calendarEventId
      ? await this.#event(principal, input.calendarEventId, now)
      : null
    const me = { email: principal.email, name: principal.name }
    const people = event && event.attendees.length > 0 ? event.attendees : [me]
    const meta: SessionMeta = {
      id: newId(),
      owner: principal.email.toLowerCase(),
      ownerName: principal.name,
      space: space.name,
      title: oneLine(input.title) || event?.title || `${clockTimeIn(now, tz)} Meeting`,
      template: template.id,
      templateHeadings: template.sections.map((s) => s.heading),
      startedAt: now.toISOString(),
      tz,
      state: 'recording',
      rawNotes: '',
      attendees: people.map(attendeeLabel),
      companies: externalDomains(
        people.map((p) => p.email),
        this.#opts.internalDomains,
      ),
    }
    if (input.calendarEventId) meta.calendarEventId = input.calendarEventId
    if (event?.seriesId) meta.calendarSeriesId = event.seriesId
    if (input.meetCode) meta.meetCode = input.meetCode
    await this.#store.create(meta)
    const live = this.#live({
      meta,
      bytes: { me: 0, them: 0 },
      segments: [],
      lastActive: now.getTime(),
    })
    this.#sessions.set(meta.id, live)
    return toSession(live)
  }

  /** The session, for its owner only: not_found, or forbidden for anyone else. */
  get(id: string, principal: Principal): MeetingSession {
    return toSession(this.#owned(id, principal))
  }

  /** The principal's sessions that aren't saved yet, newest first, so Home can offer them. */
  list(principal: Principal): MeetingSession[] {
    const owner = principal.email.toLowerCase()
    return (
      [...this.#sessions.values()]
        .filter((live) => live.meta.owner === owner && live.meta.state !== 'saved')
        // The map is in creation order; reversed first, sessions started the same millisecond
        // stay newest first through the (stable) sort.
        .reverse()
        .sort((a, b) => Date.parse(b.meta.startedAt) - Date.parse(a.meta.startedAt))
        .map(toSession)
    )
  }

  /** Makes `socket` the session's connection (closing an older one) and starts transcribing. */
  async attachAudio(id: string, socket: AudioSocket): Promise<AudioConnection> {
    const live = this.#require(id)
    this.#assertOpen(live)
    await this.#ensureTranscriber(live)
    this.#assertOpen(live) // stopped while the transcriber started
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = null
    const previous = live.socket
    live.socket = socket
    previous?.close(WS_REPLACED, 'replaced by a newer connection')
    return {
      resumeFrom: { ...live.bytes },
      audio: (frame) => this.#audio(live, socket, frame),
      detach: () => this.#detach(live, socket),
    }
  }

  async setRawNotes(id: string, text: string): Promise<void> {
    const live = this.#require(id)
    this.#assertOpen(live)
    live.meta.rawNotes = text
    await this.#store.writeMeta(live.meta)
  }

  /**
   * Remembers the member's Keep audio choice, so every way the meeting ends honours it: Stop on
   * this page or another, Save it now, or the server saving an abandoned session.
   */
  async setKeepAudio(id: string, keep: boolean): Promise<MeetingSession> {
    const live = this.#require(id)
    this.#assertOpen(live)
    if (keep && !this.canKeepAudio) {
      throw new HearthError('bad_request', 'Keeping audio isn’t set up on this server')
    }
    live.meta.keepAudio = keep
    await this.#store.writeMeta(live.meta)
    return toSession(live)
  }

  async pause(id: string): Promise<MeetingSession> {
    const live = this.#require(id)
    this.#assertOpen(live)
    if (live.meta.state === 'recording') await this.#setState(live, 'paused')
    return toSession(live)
  }

  async resume(id: string): Promise<MeetingSession> {
    const live = this.#require(id)
    this.#assertOpen(live)
    if (live.meta.state === 'paused') await this.#setState(live, 'recording')
    return toSession(live)
  }

  /**
   * Flushes the transcriber, writes the three files (ARCHITECTURE §7.4) and commits them to the
   * owner's personal space as `meetings: capture "<title>"`, then drops the audio unless kept.
   * Safe to call again: a stop that failed (the push, say) can be retried, a saved one returns
   * where it was saved.
   *
   * `notes`, when given, replace the raw notes first: the client sends its last words with Stop,
   * so a `notes` frame still queued behind audio can't overtake them (it arrives after the stop
   * began, and is refused like any other change to a stopped session).
   */
  stop(id: string, opts: { keepAudio?: boolean; notes?: string } = {}): Promise<SavedMeeting> {
    const live = this.#require(id)
    if (live.meta.saved) return Promise.resolve(live.meta.saved)
    if (opts.keepAudio && !this.canKeepAudio) {
      return Promise.reject(
        new HearthError('bad_request', 'Keeping audio isn’t set up on this server'),
      )
    }
    if (!live.stopping) {
      // A stop that says is the member's latest choice; it's kept with the session, so a retry
      // after a failed save (Save it now, the idle sweep) still honours it.
      if (opts.keepAudio !== undefined) live.meta.keepAudio = opts.keepAudio
      const keep = live.meta.keepAudio ?? this.#opts.keepAudio
      live.stopping = this.#stop(live, keep, opts.notes).finally(() => {
        live.stopping = null
      })
    }
    return live.stopping
  }

  /** Whether a stop may keep the audio (an AUDIO_STORE is configured), and whether it does by default. */
  get canKeepAudio(): boolean {
    return Boolean(this.#opts.audioStore)
  }

  get keepsAudioByDefault(): boolean {
    return this.canKeepAudio && this.#opts.keepAudio
  }

  /** Resolves when every kept-audio upload started so far has finished, for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background])
  }

  /**
   * Ends audio files and transcribers, for shutdown. Sessions stay on disk for recovery. Uploads
   * in flight get a short while to finish; one cut off starts again at the next startup.
   */
  async close(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper)
    this.#sweeper = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const uploads = Promise.race([
      this.settled(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_UPLOAD_WAIT_MS)
      }),
    ])
    // Every session's transcriber finishes at once, alongside the upload wait, so a few open
    // meetings fit inside the host's kill timeout.
    const finishing = [...this.#sessions.values()].map(async (live) => {
      // Closing the socket detaches it, which would start the idle timer; clear it after.
      live.socket?.close(1001, 'server shutting down')
      live.socket = null
      if (live.idleTimer) clearTimeout(live.idleTimer)
      live.idleTimer = null
      await this.#finishTranscriber(live)
      await this.#closeAudio(live)
    })
    await Promise.all([uploads, Promise.allSettled(finishing)])
    clearTimeout(timer)
    // The transcribers' last segments are being appended to disk; recovery reads them back.
    while (this.#segmentWrites.size > 0) await Promise.allSettled([...this.#segmentWrites])
  }

  // ── internals ────────────────────────────────────────────────────────

  #live(r: RecoveredSession): Live {
    return {
      meta: r.meta,
      bytes: r.bytes,
      segments: r.segments,
      audio: {},
      transcriber: null,
      transcriberStarting: null,
      socket: null,
      idleSince: r.lastActive,
      idleTimer: null,
      stopping: null,
    }
  }

  #require(id: string): Live {
    const live = this.#sessions.get(id)
    if (!live) throw new HearthError('not_found', 'No such meeting session')
    return live
  }

  #owned(id: string, principal: Principal): Live {
    const live = this.#require(id)
    if (live.meta.owner !== principal.email.toLowerCase()) {
      throw new HearthError('forbidden', 'This meeting session belongs to someone else')
    }
    return live
  }

  #assertOpen(live: Live): void {
    if (live.meta.state === 'stopped' || live.meta.state === 'saved') {
      throw new HearthError('conflict', 'This meeting has been stopped')
    }
  }

  async #event(principal: Principal, id: string, at: Date) {
    try {
      return await findEvent(this.#opts.calendar, principal, id, at)
    } catch (err) {
      // An ad-hoc meeting is better than no meeting.
      this.#log(`calendar event ${id} for ${principal.email}: ${err}`)
      return null
    }
  }

  async #ensureTranscriber(live: Live): Promise<void> {
    if (live.transcriber) return
    if (!live.transcriberStarting) {
      live.transcriberStarting = this.#opts.transcriber
        .start({ sessionId: live.meta.id })
        .then((session) => {
          // A transcriber hears only the audio after it starts; its times count from there.
          const base = { ...live.bytes }
          session.on('segment', (seg) => this.#segment(live, base, seg))
          session.on('error', (err) => live.socket?.send({ type: 'error', message: err.message }))
          live.transcriber = session
        })
        .finally(() => {
          live.transcriberStarting = null
        })
    }
    await live.transcriberStarting
  }

  #segment(live: Live, base: Record<Track, number>, seg: TranscriptSegment): void {
    const segment = { ...seg, at: seg.at + Math.floor(base[seg.track] / PCM_BYTES_PER_MS) }
    if (segment.final) {
      live.segments.push(segment)
      const write = this.#store
        .appendSegment(live.meta.id, segment)
        .catch((err) => this.#log(`meeting ${live.meta.id}: saving a segment failed: ${err}`))
        .finally(() => this.#segmentWrites.delete(write))
      this.#segmentWrites.add(write)
    }
    live.socket?.send({ type: 'segment', segment })
  }

  #audio(live: Live, socket: AudioSocket, frame: Uint8Array): void {
    if (live.socket !== socket) return
    const parsed = parseAudioFrame(frame)
    if ('error' in parsed) {
      socket.send({ type: 'error', message: parsed.error })
      return
    }
    const { track, pcm } = parsed
    // Pausing is the client's recorder's job. Audio that arrives while paused is still kept: it
    // can be what the client recorded before a pause made over HTTP, replayed on reconnect, and
    // counting it keeps `resumeFrom` equal to the client's offsets.
    if (live.meta.state === 'stopped' || live.meta.state === 'saved' || pcm.length === 0) return
    const allowed =
      (this.#now().getTime() - Date.parse(live.meta.startedAt) + AUDIO_SLACK_MS) * PCM_BYTES_PER_MS
    if (live.bytes[track] + pcm.length > allowed) {
      if (!live.overCap) {
        live.overCap = true
        this.#log(`meeting ${live.meta.id}: dropping ${track} audio beyond real time`)
        socket.send({ type: 'error', message: 'More audio arrived than the meeting has run for' })
      }
      return
    }
    this.#audioFile(live, track).write(pcm)
    live.bytes[track] += pcm.length
    live.transcriber?.sendAudio(track, pcm)
  }

  #audioFile(live: Live, track: Track): WriteStream {
    let stream = live.audio[track]
    if (!stream) {
      stream = this.#store.openAudio(live.meta.id, track)
      stream.on('error', (err) => {
        this.#log(`meeting ${live.meta.id}: writing ${track} audio failed: ${err}`)
        live.socket?.send({ type: 'error', message: 'The server could not save audio' })
      })
      live.audio[track] = stream
    }
    return stream
  }

  #detach(live: Live, socket: AudioSocket): void {
    if (live.socket !== socket) return
    live.socket = null
    live.idleSince = this.#now().getTime()
    if (live.meta.state !== 'recording' && live.meta.state !== 'paused') return
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null
      // The audio files reopen on the next frame.
      void this.#finishTranscriber(live).then(() => this.#closeAudio(live))
    }, this.#opts.detachGraceMs ?? DETACH_GRACE_MS)
    live.idleTimer.unref()
  }

  async #finishTranscriber(live: Live): Promise<void> {
    await live.transcriberStarting?.catch(() => {})
    const transcriber = live.transcriber
    live.transcriber = null
    await transcriber?.finish()
  }

  async #closeAudio(live: Live): Promise<void> {
    const streams = TRACKS.flatMap((t) => (live.audio[t] ? [live.audio[t]] : []))
    live.audio = {}
    await Promise.all(streams.map((s) => new Promise<void>((resolve) => s.end(() => resolve()))))
  }

  async #setState(live: Live, state: SessionState): Promise<void> {
    live.meta.state = state
    await this.#store.writeMeta(live.meta)
    live.socket?.send({ type: 'state', state })
  }

  async #stop(live: Live, keepAudio: boolean, notes: string | undefined): Promise<SavedMeeting> {
    const { meta } = live
    if (notes !== undefined) meta.rawNotes = notes
    if (meta.state !== 'stopped') await this.#setState(live, 'stopped')
    else await this.#store.writeMeta(meta)
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = null
    await this.#finishTranscriber(live)
    await this.#closeAudio(live)

    const input: CaptureInput = {
      id: meta.id,
      title: meta.title,
      templateId: meta.template,
      templateHeadings: meta.templateHeadings,
      startedAt: new Date(meta.startedAt),
      tz: meta.tz,
      audioBytes: Math.max(live.bytes.me, live.bytes.them),
      attendees: meta.attendees,
      companies: meta.companies,
      calendarEventId: meta.calendarEventId,
      calendarSeriesId: meta.calendarSeriesId,
      rawNotes: meta.rawNotes,
      segments: live.segments,
    }
    const paths = await this.#saves.run(meta.space, async () => {
      const free = await this.#freePaths(meta.space, input)
      const result = await this.#opts.git.commit(meta.space, {
        changes: captureFiles(input, free),
        author: { name: meta.ownerName, email: meta.owner },
        message: formatCommitMessage({ app: 'meetings', verb: 'capture', title: meta.title }),
      })
      if (result.status === 'conflict') {
        throw new HearthError('internal', 'Unexpected conflict while saving a meeting')
      }
      return free
    })
    const store = keepAudio ? (this.#opts.audioStore ?? null) : null
    // Recorded before anything is deleted, so a crash from here on can't lose the transcript, or
    // the audio still to upload.
    meta.saved = { space: meta.space, path: paths.note, transcriptPath: paths.transcript }
    if (store) meta.audioPending = true
    await this.#setState(live, 'saved')
    if (store) this.#pendingAudio.set(meta.id, { meta, retryAt: 0 })
    // The transcript and notes are committed; memory keeps only where they went.
    live.segments = []
    meta.rawNotes = ''
    try {
      await this.#opts.afterCommit(meta.space)
    } catch (err) {
      // The files are committed; the poller will index them.
      this.#log(`meeting ${meta.id}: indexing after save failed: ${err}`)
    }
    // Kept audio stays on disk until it's uploaded, then goes.
    await this.#store.cleanUp(meta.id, { keepAudio: store !== null })
    live.socket?.close(1000, 'saved')
    live.socket = null
    if (store) {
      // In the background: a long meeting's audio takes a while to upload, and the member is
      // waiting on the note, which is already saved.
      this.#uploadKeptAudio(meta.id)
    }
    return meta.saved
  }

  /** Starts a pending upload unless one is running; a failure is tried again by the sweep. */
  #uploadKeptAudio(id: string): void {
    const pending = this.#pendingAudio.get(id)
    const store = this.#opts.audioStore
    if (!pending || this.#uploading.has(id)) return
    if (!store) {
      // AUDIO_STORE was turned off since: keep the PCM, and don't ask again until a restart.
      this.#log(`meeting ${id}: audio waits to be kept, but no audio store is configured`)
      this.#pendingAudio.delete(id)
      return
    }
    this.#uploading.add(id)
    const upload = this.#keepAudio(pending.meta, store)
      .then((done) => {
        if (done) this.#pendingAudio.delete(id)
        else pending.retryAt = this.#now().getTime() + AUDIO_RETRY_MS
      })
      .finally(() => {
        this.#uploading.delete(id)
        this.#background.delete(upload)
      })
    this.#background.add(upload)
  }

  /**
   * Uploads each track as WAV to the audio store, commits the pointer file
   * `.hearth/meetings/audio/<id>.yaml` to the owner's space, then deletes the PCM. A failure
   * leaves the PCM in the session directory and answers false, so nothing is lost.
   */
  async #keepAudio(meta: SessionMeta, store: AudioStore): Promise<boolean> {
    try {
      const tracks: Partial<Record<Track, { key: string; bytes: number; seconds: number }>> = {}
      for (const track of TRACKS) {
        const file = this.#store.audioPath(meta.id, track)
        const pcmBytes = await fileSize(file)
        if (pcmBytes === 0) continue
        const key = keptAudioKey(meta.space, meta.id, track)
        const bytes = pcmBytes + WAV_HEADER_BYTES
        await store.put(key, wavStream(file, pcmBytes), bytes, 'audio/wav')
        tracks[track] = { key, bytes, seconds: pcmSeconds(pcmBytes) }
      }
      if (Object.keys(tracks).length === 0) {
        await this.#audioKept(meta)
        return true
      }
      const pointer = keptAudioPointer({
        id: meta.id,
        note: meta.saved?.path ?? '',
        store: store.kind,
        tracks,
      })
      await this.#saves.run(meta.space, async () => {
        const result = await this.#opts.git.commit(meta.space, {
          changes: [{ path: keptAudioPath(meta.id), content: pointer }],
          author: { name: meta.ownerName, email: meta.owner },
          message: formatCommitMessage({ app: 'meetings', verb: 'keep audio', title: meta.title }),
        })
        if (result.status === 'conflict') {
          throw new HearthError('internal', 'Unexpected conflict while keeping audio')
        }
      })
      await this.#audioKept(meta)
      try {
        await this.#opts.afterCommit(meta.space)
      } catch (err) {
        this.#log(`meeting ${meta.id}: indexing after keeping audio failed: ${err}`)
      }
      return true
    } catch (err) {
      this.#log(`meeting ${meta.id}: keeping audio failed, the PCM stays on the volume: ${err}`)
      return false
    }
  }

  /**
   * The upload is done: delete the PCM, then forget it's pending. In that order, a crash between
   * the two leaves the flag, and the retry at startup finds no PCM and just clears it.
   */
  async #audioKept(meta: SessionMeta): Promise<void> {
    await this.#store.cleanUp(meta.id, { keepAudio: false })
    delete meta.audioPending
    await this.#store.writeMeta(meta)
  }

  /**
   * The first `-n` suffix whose note and transcript are both free at HEAD, or already this
   * meeting's (a retried stop whose commit landed but whose push failed rewrites the same files).
   */
  async #freePaths(space: string, input: CaptureInput): Promise<CapturePaths> {
    for (let n = 1; n < 1000; n++) {
      const paths = capturePaths(input, n)
      const note = await this.#read(space, paths.note)
      if (note !== null) {
        if (parseFrontmatter(note).data.id === input.id) return paths
        continue
      }
      if ((await this.#read(space, paths.transcript)) === null) return paths
    }
    throw new HearthError('conflict', `Too many meetings called "${input.title}" that day`)
  }

  async #read(space: string, path: string): Promise<string | null> {
    try {
      return (await this.#opts.git.readFile(space, path)).content
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
  }
}

function toSession(live: Live): MeetingSession {
  const { meta } = live
  const session: MeetingSession = {
    id: meta.id,
    owner: meta.owner,
    space: meta.space,
    title: meta.title,
    template: meta.template,
    startedAt: meta.startedAt,
    state: meta.state,
    rawNotes: meta.rawNotes,
    segments: [...live.segments],
  }
  if (meta.calendarEventId) session.calendarEventId = meta.calendarEventId
  if (meta.meetCode) session.meetCode = meta.meetCode
  if (meta.keepAudio !== undefined) session.keepAudio = meta.keepAudio
  if (meta.saved) session.saved = meta.saved
  return session
}

function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}
