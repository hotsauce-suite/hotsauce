// The live meeting socket, `/ws/meetings/:id` (ARCHITECTURE §7.3).
//
// Auth is the first message, as on `/ws`. After the server's `ready`, audio goes out as binary
// frames (byte 0 = track, then PCM16 LE). Every frame is also written to the IndexedDB ring
// first, so when the connection drops the server's `resumeFrom` byte counts on the next
// `ready` say exactly what to resend.

import { getAuthHeaders } from '../../../api/client'
import type {
  MeetingClientMessage,
  MeetingServerMessage,
  MeetingState,
  Track,
  TranscriptSegment,
} from '../../../api/types'
import { authMessage } from '../../../api/ws'
import type { AudioRing } from './ring-buffer'

export const TRACKS: readonly Track[] = ['me', 'them']
const TRACK_BYTE: Record<Track, number> = { me: 0, them: 1 }

/**
 * Close codes after which reconnecting can't help: not the owner, no such session, or another
 * connection (a second tab or device) took the session over. Reconnecting after 4409 would only
 * take it back and leave the two fighting.
 */
const FATAL_CLOSE_CODES = new Set([4403, 4404, 4409])
const CLOSE_MESSAGES: Record<number, string> = {
  4409: 'Another tab or device is recording this meeting now.',
}

export type LinkStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export function encodeAudioFrame(track: Track, pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(pcm.byteLength + 1)
  frame[0] = TRACK_BYTE[track]
  frame.set(pcm, 1)
  return frame
}

export function decodeAudioFrame(frame: Uint8Array): { track: Track; pcm: Uint8Array } | null {
  const track = frame[0] === 0 ? 'me' : frame[0] === 1 ? 'them' : null
  return track ? { track, pcm: frame.subarray(1) } : null
}

/**
 * Folds one server segment into the transcript. A partial replaces the track's pending
 * partial in place, and so does the final that settles it, so lines never jump. A final the
 * list already has (same track and start, replayed after a reconnect) replaces its copy.
 */
export function applySegment(
  list: readonly TranscriptSegment[],
  segment: TranscriptSegment,
): TranscriptSegment[] {
  let index = segment.final
    ? list.findIndex((s) => s.final && s.track === segment.track && s.at === segment.at)
    : -1
  if (index === -1) index = list.findIndex((s) => !s.final && s.track === segment.track)
  if (index === -1) return [...list, segment]
  const next = list.slice()
  next[index] = segment
  return next
}

// `skipped` per session, in localStorage beside the notes draft, so a reload after a long outage
// still knows how far the server's byte counts run behind this device's offsets.
const SKIPPED_PREFIX = 'hearth.meeting-skipped:'

export function skippedKey(sessionId: string): string {
  return `${SKIPPED_PREFIX}${sessionId}`
}

function loadSkipped(sessionId: string): Record<Track, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(skippedKey(sessionId)) ?? '{}')
    const bytes = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0)
    return { me: bytes(saved?.me), them: bytes(saved?.them) }
  } catch {
    return { me: 0, them: 0 }
  }
}

function saveSkipped(sessionId: string, skipped: Record<Track, number>): void {
  try {
    localStorage.setItem(skippedKey(sessionId), JSON.stringify(skipped))
  } catch {
    // Best-effort, like the draft: without it a reload may resend audio the server has.
  }
}

/** Forgets a session's `skipped`, with its ring (after Stop). */
export function forgetSkipped(sessionId: string): void {
  try {
    localStorage.removeItem(skippedKey(sessionId))
  } catch {
    // Best-effort.
  }
}

export function meetingSocketUrl(sessionId: string): string {
  const url = new URL(`/ws/meetings/${encodeURIComponent(sessionId)}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

interface Events {
  /** The server took this connection; text frames can go now. */
  ready: undefined
  /** The whole transcript after each segment. */
  transcript: readonly TranscriptSegment[]
  state: MeetingState
  error: string
  status: LinkStatus
}

export interface MeetingSocketOptions {
  sessionId: string
  ring: AudioRing
  url?: string
  minBackoffMs?: number
  maxBackoffMs?: number
}

export class MeetingSocket {
  readonly sessionId: string
  private readonly ring: AudioRing
  private readonly url: string
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number

  private ws: WebSocket | null = null
  private stopped = true
  /** This connection got `ready`; the server takes no frames before it. */
  private ready = false
  private everReady = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private statusValue: LinkStatus = 'connecting'
  private segments: readonly TranscriptSegment[] = []
  private readonly listeners: { [E in keyof Events]: Set<(value: Events[E]) => void> } = {
    ready: new Set(),
    transcript: new Set(),
    state: new Set(),
    error: new Set(),
    status: new Set(),
  }

  /** Bytes captured per track; the next frame's offset in the track's stream. */
  private captured: Record<Track, number> = { me: 0, them: 0 }
  /** Bytes per track the server has or that are already on the wire to it. */
  private sent: Record<Track, number> = { me: 0, them: 0 }
  /** What the server said it holds at its last `ready` (plus bytes the ring dropped). */
  private confirmed: Record<Track, number> = { me: 0, them: 0 }
  /**
   * Bytes per track lost to an outage longer than the ring keeps; the server never gets them.
   * Kept in localStorage, since a reload can't work it out again.
   */
  private skipped: Record<Track, number>
  /** Ready and caught up: new frames go straight out. Until then they wait in the ring. */
  private live = false
  /** Ring writes, in order; a replay waits for them before reading. */
  private writes: Promise<void> = Promise.resolve()
  /** Frames captured before the ring said where this session's streams end. */
  private pending: Array<[Track, Uint8Array]> | null = []
  private readonly offsetsLoaded: Promise<void>

  constructor(opts: MeetingSocketOptions) {
    this.sessionId = opts.sessionId
    this.ring = opts.ring
    this.url = opts.url ?? meetingSocketUrl(opts.sessionId)
    this.minBackoffMs = opts.minBackoffMs ?? 500
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000
    this.skipped = loadSkipped(opts.sessionId)
    // After a reload the ring still holds this session's audio; new frames continue after it.
    this.offsetsLoaded = Promise.all(TRACKS.map((t) => this.ring.end(this.sessionId, t))).then(
      ([me = 0, them = 0]) => {
        this.captured = { me, them }
        const queued = this.pending ?? []
        this.pending = null
        for (const [track, pcm] of queued) this.accept(track, pcm)
      },
    )
  }

  get status(): LinkStatus {
    return this.statusValue
  }

  get transcript(): readonly TranscriptSegment[] {
    return this.segments
  }

  on<E extends keyof Events>(event: E, listener: (value: Events[E]) => void): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  /** Starts from a transcript fetched over HTTP, e.g. after a reload. */
  seedTranscript(segments: readonly TranscriptSegment[]): void {
    this.segments = segments.reduce<TranscriptSegment[]>(applySegment, [])
    this.emit('transcript', this.segments)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.offsetsLoaded.then(() => this.connect())
  }

  stop(): void {
    this.stopped = true
    this.ready = false
    this.live = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    ws?.close(1000)
    this.setStatus('closed')
  }

  /** One frame of 16 kHz mono PCM16 LE for `track`. */
  sendAudio(track: Track, pcm: Uint8Array): void {
    if (this.pending) this.pending.push([track, pcm])
    else this.accept(track, pcm)
  }

  /**
   * Resolves true once everything captured so far has left this page over a live link (or the
   * server has confirmed it). False after `timeoutMs`.
   * Stop waits on this so the server doesn't save before the last seconds of audio arrive
   * (after a reconnect they are still being resent from the ring).
   */
  async flushed(timeoutMs: number, pollMs = 50): Promise<boolean> {
    await this.offsetsLoaded
    const target: Record<Track, number> = { ...this.captured }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await this.writes
      // The server already confirmed holding all of it (its last `ready`)...
      if (TRACKS.every((t) => target[t] <= this.confirmed[t])) return true
      // ...or the link is live, caught up, has sent all of it and its buffer is empty. Bytes
      // handed to a socket that then dropped count for nothing until a reconnect resends them.
      const ws = this.ws
      const sent = TRACKS.every((t) => this.sent[t] >= target[t])
      if (this.live && sent && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) {
        return true
      }
      if (this.stopped || Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /** Sends a text frame; false when the socket isn't ready (use HTTP instead). */
  send(message: MeetingClientMessage): boolean {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(message))
    return true
  }

  private accept(track: Track, pcm: Uint8Array): void {
    const offset = this.captured[track]
    this.captured[track] = offset + pcm.byteLength
    this.writes = this.writes.then(() => this.ring.append(this.sessionId, track, offset, pcm))
    if (this.live && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeAudioFrame(track, pcm))
      this.sent[track] = this.captured[track]
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus(this.everReady ? 'reconnecting' : 'connecting')
    this.ready = false
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('open', () => void this.authenticate(ws))
    ws.addEventListener('message', (event) => this.handle(ws, event.data))
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.ready = false
      this.live = false
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.stopped = true
        // The reason first, so whoever reacts to `closed` can say why.
        this.emit(
          'error',
          CLOSE_MESSAGES[event.code] ?? (event.reason || 'This meeting is no longer available.'),
        )
        this.setStatus('closed')
        return
      }
      this.scheduleReconnect()
    })
  }

  private async authenticate(ws: WebSocket): Promise<void> {
    const message = authMessage(await getAuthHeaders())
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
    if (!message) {
      this.emit('error', 'Sign in again to keep recording.')
      this.stop()
      return
    }
    ws.send(JSON.stringify(message))
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.setStatus('reconnecting')
    const delay = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempts)
    this.attempts += 1
    this.timer = setTimeout(() => this.connect(), delay)
  }

  private handle(ws: WebSocket, data: unknown): void {
    if (this.ws !== ws || typeof data !== 'string') return
    let message: MeetingServerMessage
    try {
      message = JSON.parse(data) as MeetingServerMessage
    } catch {
      return
    }
    switch (message.type) {
      case 'ready':
        this.attempts = 0
        this.ready = true
        this.everReady = true
        this.emit('ready', undefined)
        void this.catchUp(ws, message.resumeFrom)
        break
      case 'segment':
        this.segments = applySegment(this.segments, message.segment)
        this.emit('transcript', this.segments)
        break
      case 'state':
        this.emit('state', message.state)
        // A stopped meeting takes no more audio; reconnecting would only be refused.
        if (message.state === 'stopped' || message.state === 'saved') this.stop()
        break
      case 'error':
        this.emit('error', message.message)
        break
    }
  }

  /** Resends from the ring whatever the server is missing, then goes live. */
  private async catchUp(ws: WebSocket, resumeFrom: Partial<Record<Track, number>>): Promise<void> {
    await this.offsetsLoaded
    const closed = () => this.ws !== ws || ws.readyState !== WebSocket.OPEN
    for (const track of TRACKS) {
      // The server counts only what it received; bytes the ring had already dropped never
      // reach it, so its count runs `skipped` behind our offsets.
      const has = Math.max(0, resumeFrom?.[track] ?? 0) + this.skipped[track]
      this.sent[track] = has
      this.confirmed[track] = has
      // The server has audio this page never captured (the ring was cleared): carry on after it.
      if (has > this.captured[track]) this.captured[track] = has
    }
    this.setStatus('live')
    for (;;) {
      // A frame's offset is counted when it's captured but its ring write lands later, so
      // wait until no write is pending before trusting the ring up to `captured`.
      const writes = this.writes
      await writes
      if (closed()) return
      if (writes !== this.writes) continue
      const upTo: Record<Track, number> = { ...this.captured }
      let behind = false
      for (const track of TRACKS) {
        const from = this.sent[track]
        const to = upTo[track]
        if (from >= to) continue
        behind = true
        const chunks = await this.ring.read(this.sessionId, track, from, to)
        if (closed()) return
        let resent = 0
        for (const chunk of chunks) {
          ws.send(encodeAudioFrame(track, chunk.bytes))
          resent += chunk.bytes.byteLength
        }
        if (resent < to - from) {
          this.skipped[track] += to - from - resent
          saveSkipped(this.sessionId, this.skipped)
        }
        this.sent[track] = to
      }
      // A pass with nothing to send made no awaits after its check, so no frame can slip in
      // between the check and going live; frames captured during a pass's reads are the next
      // pass's.
      if (!behind) break
    }
    this.live = true
  }

  private setStatus(status: LinkStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.emit('status', status)
  }

  private emit<E extends keyof Events>(event: E, value: Events[E]): void {
    for (const listener of this.listeners[event]) listener(value)
  }
}
