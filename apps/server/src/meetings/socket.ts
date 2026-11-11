import { z } from 'zod'
import type { Authenticator, Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import {
  MAX_AUTH_FRAME_BYTES,
  principalFromAuthMessage,
  WS_UNAUTHORIZED,
} from '../sync/handshake.js'
import type { AudioConnection, AudioSocket, MeetingSessions, ServerMessage } from './sessions.js'

/** Close codes besides 4401 (unauthorized) and 4409 (replaced by a newer connection). */
export const WS_FORBIDDEN = 4403
export const WS_NOT_FOUND = 4404
const WS_TOO_BIG = 1009
const WS_INTERNAL = 1011

/** Audio frames are 100 ms of PCM16 (3.2 KB); this leaves room for a client that batches. */
export const MAX_MEETING_FRAME_BYTES = 256 * 1024

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notes'), text: z.string() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
])

/** What the handler needs from a WebSocket; the `ws` library's socket provides all four. */
export interface RawSocket {
  send(data: string): void
  close(code: number, reason: string): void
  ping(): void
  terminate(): void
}

export interface MeetingSocketHandlers {
  text(data: string): void
  binary(data: Uint8Array): void
  pong(): void
  closed(): void
}

/**
 * `/ws/meetings/:id` (ARCHITECTURE §7.3). The first message is the same auth as `/ws`; then the
 * owner gets `{ type: 'ready', sessionId, resumeFrom }` and streams binary audio frames and JSON
 * `notes` / `pause` / `resume` messages. Anything before `ready` other than the auth message
 * closes the socket: 4401 unauthenticated, 4403 not the owner, 4404 no such open session.
 * Like `/ws`, a protocol ping goes out every 30 s and a client that missed the last one is
 * dropped, so a laptop that vanished mid-meeting frees its session for the idle timer.
 */
export class MeetingSocketServer {
  readonly #auth: Authenticator
  readonly #sessions: MeetingSessions
  readonly #authUrl: string
  readonly #authTimeoutMs: number
  readonly #heartbeatMs: number
  readonly #clients = new Map<RawSocket, { alive: boolean; dropped: () => void }>()
  #heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(opts: {
    auth: Authenticator
    sessions: MeetingSessions
    publicUrl: string
    authTimeoutMs?: number
    heartbeatMs?: number
  }) {
    this.#auth = opts.auth
    this.#sessions = opts.sessions
    this.#authUrl = new URL('/ws/meetings', opts.publicUrl).href
    this.#authTimeoutMs = opts.authTimeoutMs ?? 5_000
    this.#heartbeatMs = opts.heartbeatMs ?? 30_000
  }

  start(): void {
    if (this.#heartbeat) return
    this.#heartbeat = setInterval(() => {
      for (const [socket, client] of this.#clients) {
        if (!client.alive) {
          client.dropped()
          socket.terminate()
          continue
        }
        client.alive = false
        socket.ping()
      }
    }, this.#heartbeatMs)
  }

  stop(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  connect(sessionId: string, socket: RawSocket): MeetingSocketHandlers {
    let state: 'waiting' | 'authenticating' | 'ready' | 'closed' = 'waiting'
    let connection: AudioConnection | null = null
    const forget = () => {
      state = 'closed'
      clearTimeout(timer)
      this.#clients.delete(socket)
      connection?.detach()
    }
    const close = (code: number, reason: string) => {
      if (state === 'closed') return
      forget()
      socket.close(code, reason)
    }
    const client = { alive: true, dropped: forget }
    this.#clients.set(socket, client)
    const timer = setTimeout(
      () => close(WS_UNAUTHORIZED, 'authentication timed out'),
      this.#authTimeoutMs,
    )
    const send = (message: ServerMessage) => {
      if (state === 'ready') socket.send(JSON.stringify(message))
    }

    const start = async (data: string) => {
      state = 'authenticating'
      const principal = await principalFromAuthMessage(this.#auth, this.#authUrl, data)
      if (state !== 'authenticating') return
      if (principal === null) return close(WS_UNAUTHORIZED, 'unauthorized')
      try {
        const attached = await this.#attach(sessionId, principal, {
          send,
          close: (code, reason) => close(code, reason),
        })
        if (state !== 'authenticating') {
          attached.detach()
          return
        }
        connection = attached
      } catch (err) {
        return close(...closeFor(err))
      }
      clearTimeout(timer)
      state = 'ready'
      send({ type: 'ready', sessionId, resumeFrom: connection.resumeFrom })
      send({ type: 'state', state: this.#sessions.get(sessionId, principal).state })
    }

    return {
      text: (data) => {
        if (state === 'waiting') {
          if (Buffer.byteLength(data) > MAX_AUTH_FRAME_BYTES) close(WS_TOO_BIG, 'frame too large')
          else void start(data)
        } else if (state === 'ready') void this.#message(sessionId, data, send)
        else if (state === 'authenticating') close(WS_UNAUTHORIZED, 'wait for ready')
      },
      binary: (data) => {
        if (state === 'ready') connection?.audio(data)
        else if (state !== 'closed') close(WS_UNAUTHORIZED, 'audio before authentication')
      },
      pong: () => {
        client.alive = true
      },
      closed: () => {
        if (state !== 'closed') forget()
      },
    }
  }

  async #attach(
    sessionId: string,
    principal: Principal,
    socket: AudioSocket,
  ): Promise<AudioConnection> {
    const session = this.#sessions.get(sessionId, principal)
    if (session.state === 'saved') throw new HearthError('not_found', 'already saved')
    return this.#sessions.attachAudio(sessionId, socket)
  }

  async #message(sessionId: string, data: string, send: (m: ServerMessage) => void): Promise<void> {
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      json = null
    }
    const message = ClientMessage.safeParse(json)
    if (!message.success) {
      send({ type: 'error', message: 'Unknown message' })
      return
    }
    try {
      if (message.data.type === 'notes')
        await this.#sessions.setRawNotes(sessionId, message.data.text)
      else if (message.data.type === 'pause') await this.#sessions.pause(sessionId)
      else await this.#sessions.resume(sessionId)
    } catch (err) {
      send({
        type: 'error',
        message: err instanceof HearthError ? err.message : 'Something went wrong',
      })
      if (!(err instanceof HearthError)) console.error(`meeting ${sessionId}:`, err)
    }
  }
}

function closeFor(err: unknown): [number, string] {
  if (err instanceof HearthError) {
    if (err.code === 'forbidden') return [WS_FORBIDDEN, 'not your meeting']
    if (err.code === 'not_found' || err.code === 'conflict') return [WS_NOT_FOUND, err.message]
  }
  console.error('meeting socket attach failed:', err)
  return [WS_INTERNAL, 'could not start the session']
}
