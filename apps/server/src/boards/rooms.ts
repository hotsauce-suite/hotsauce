// Live drawing together on one board (ARCHITECTURE §15.5): one room per board, in memory. The
// server relays what each editor draws and where its pointer is to the others in the room; it
// stores nothing. Saving stays the HTTP save (each editor saves what it has, merged by element
// version), so a dropped socket or a restart loses nothing but cursors.

import { BLOCKED_ELEMENT_TYPES, isId } from '@hearth/format'
import { z } from 'zod'
import type { Authenticator, Principal } from '../auth/index.js'
import {
  MAX_AUTH_FRAME_BYTES,
  principalFromAuthMessage,
  WS_UNAUTHORIZED,
} from '../sync/handshake.js'

/** A scene message is a batch of changed elements; the client splits bigger changes. */
export const MAX_BOARD_FRAME_BYTES = 256 * 1024
const MAX_ELEMENTS_PER_MESSAGE = 2_000
/** People in one room. */
export const MAX_ROOM_PEERS = 50
/** Messages a peer may send per second (pointer moves are throttled by the client to ~20/s). */
const RATE_PER_SECOND = 120

const WS_FORBIDDEN = 4403
const WS_TOO_BIG = 1009
const WS_POLICY = 1008
const WS_GOING_AWAY = 1001
const WS_TRY_LATER = 1013

export interface RoomSocket {
  send(data: string): void
  /** Bytes queued and not yet sent. */
  bufferedAmount(): number
  close(code: number, reason: string): void
  ping(): void
  terminate(): void
}

export interface RoomHandlers {
  text(data: string): void
  pong(): void
  closed(): void
}

/** What other people in the room see of you. */
export interface Peer {
  id: string
  name: string
  email: string
}

/** Bytes a peer may send per second, all messages together. */
const BYTES_PER_SECOND = 2 * 1024 * 1024
/** A receiver this far behind (unsent bytes queued) is skipped until it catches up. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

const finite = z.number().finite()
/**
 * An element as it is relayed: what Excalidraw needs to draw it safely is checked, the rest is
 * passed on as drawn. `iframe` is refused, as on a save (§15.1): Excalidraw runs its HTML.
 */
const Element = z.looseObject({
  id: z.string().min(1).max(200),
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((t) => !BLOCKED_ELEMENT_TYPES.has(t)),
  version: z.number().int().nonnegative(),
  x: finite.optional(),
  y: finite.optional(),
  width: finite.optional(),
  height: finite.optional(),
  angle: finite.optional(),
  points: z
    .array(z.tuple([finite, finite]).rest(finite))
    .max(100_000)
    .optional(),
  text: z.string().max(100_000).optional(),
  fontFamily: finite.optional(),
  fontSize: finite.optional(),
})

const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scene'),
    elements: z.array(Element).min(1).max(MAX_ELEMENTS_PER_MESSAGE),
    /** Only for this peer: catching up someone who just joined. */
    to: z.string().min(1).max(40).optional(),
  }),
  z.object({
    type: z.literal('pointer'),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['down', 'up']).optional(),
    tool: z.enum(['pointer', 'laser']).optional(),
  }),
])

interface Member {
  peer: Peer
  principal: Principal
  socket: RoomSocket
  room: string
  space: string
  alive: boolean
  /** Rate limit: messages and bytes counted in the current second. */
  window: number
  count: number
  bytes: number
}

interface Pending {
  socket: RoomSocket
  state: 'waiting' | 'authenticating' | 'closed'
  timer: ReturnType<typeof setTimeout>
}

let nextPeer = 0

export class BoardRooms {
  readonly #auth: Authenticator
  readonly #canAccess: (p: Principal, space: string) => boolean
  readonly #authUrl: string
  readonly #authTimeoutMs: number
  readonly #heartbeatMs: number
  readonly #now: () => number
  readonly #rooms = new Map<string, Set<Member>>()
  readonly #pending = new Set<Pending>()
  #heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(opts: {
    auth: Authenticator
    spaces: { canAccess(p: Principal, space: string): boolean }
    publicUrl: string
    authTimeoutMs?: number
    heartbeatMs?: number
    now?: () => number
  }) {
    this.#auth = opts.auth
    this.#canAccess = (p, space) => opts.spaces.canAccess(p, space)
    this.#authUrl = new URL('/ws', opts.publicUrl).href
    this.#authTimeoutMs = opts.authTimeoutMs ?? 5_000
    this.#heartbeatMs = opts.heartbeatMs ?? 30_000
    this.#now = opts.now ?? Date.now
  }

  /** How many people are drawing on a board now (for tests and logs). */
  size(space: string, id: string): number {
    return this.#rooms.get(roomKey(space, id))?.size ?? 0
  }

  /**
   * A socket for `/ws/boards/:space/:id`. Its first message authenticates it, as on `/ws`; then
   * it joins the board's room if the member can read the space.
   */
  connect(space: string, id: string, socket: RoomSocket): RoomHandlers {
    const pending: Pending = {
      socket,
      state: 'waiting',
      timer: setTimeout(() => {
        if (pending.state === 'closed') return
        this.#drop(pending)
        socket.close(WS_UNAUTHORIZED, 'authentication timed out')
      }, this.#authTimeoutMs),
    }
    this.#pending.add(pending)
    let member: Member | null = null
    return {
      text: (data) => {
        if (member) {
          this.#receive(member, data)
          return
        }
        if (pending.state !== 'waiting') return
        if (Buffer.byteLength(data) > MAX_AUTH_FRAME_BYTES) {
          this.#drop(pending)
          socket.close(WS_TOO_BIG, 'message too large')
          return
        }
        pending.state = 'authenticating'
        void principalFromAuthMessage(this.#auth, this.#authUrl, data)
          .catch(() => null)
          .then((principal) => {
            if (pending.state !== 'authenticating') return
            this.#drop(pending)
            if (!principal) {
              socket.close(WS_UNAUTHORIZED, 'unauthorized')
              return
            }
            if (!isId(id) || !this.#canAccess(principal, space)) {
              socket.close(WS_FORBIDDEN, 'no access to this board')
              return
            }
            member = this.#join(space, id, principal, socket)
          })
      },
      pong: () => {
        if (member) member.alive = true
      },
      closed: () => {
        this.#drop(pending)
        if (member) this.#leave(member)
        member = null
      },
    }
  }

  /** Pings every peer on an interval and drops the ones that stopped answering. */
  start(): void {
    if (this.#heartbeat) return
    this.#heartbeat = setInterval(() => {
      for (const room of this.#rooms.values()) {
        for (const m of room) {
          if (!m.alive) {
            this.#leave(m)
            m.socket.terminate()
            continue
          }
          m.alive = false
          m.socket.ping()
        }
      }
    }, this.#heartbeatMs)
  }

  stop(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    for (const p of this.#pending) {
      this.#drop(p)
      p.socket.close(WS_GOING_AWAY, 'server shutting down')
    }
    for (const room of [...this.#rooms.values()]) {
      for (const m of room) {
        this.#leave(m)
        m.socket.close(WS_GOING_AWAY, 'server shutting down')
      }
    }
  }

  #join(space: string, id: string, principal: Principal, socket: RoomSocket): Member | null {
    const key = roomKey(space, id)
    const room = this.#rooms.get(key) ?? new Set<Member>()
    if (room.size >= MAX_ROOM_PEERS) {
      socket.close(WS_TRY_LATER, 'this board is full')
      return null
    }
    nextPeer = (nextPeer + 1) % Number.MAX_SAFE_INTEGER
    const member: Member = {
      peer: {
        id: `p${nextPeer.toString(36)}`,
        name: principal.name || principal.email,
        email: principal.email.toLowerCase(),
      },
      principal,
      socket,
      room: key,
      space,
      alive: true,
      window: 0,
      count: 0,
      bytes: 0,
    }
    socket.send(
      JSON.stringify({ type: 'ready', you: member.peer, peers: [...room].map((m) => m.peer) }),
    )
    this.#send(room, { type: 'join', peer: member.peer })
    room.add(member)
    this.#rooms.set(key, room)
    return member
  }

  #leave(member: Member): void {
    const room = this.#rooms.get(member.room)
    if (!room?.delete(member)) return
    if (room.size === 0) this.#rooms.delete(member.room)
    else this.#send(room, { type: 'leave', id: member.peer.id })
  }

  #receive(member: Member, data: string): void {
    const room = this.#rooms.get(member.room)
    // Already put out of the room (the socket is still closing): nothing more is relayed.
    if (!room?.has(member)) return
    const size = Buffer.byteLength(data)
    if (size > MAX_BOARD_FRAME_BYTES) {
      this.#leave(member)
      member.socket.close(WS_TOO_BIG, 'message too large')
      return
    }
    const second = Math.floor(this.#now() / 1000)
    if (second !== member.window) {
      member.window = second
      member.count = 0
      member.bytes = 0
    }
    member.bytes += size
    // Dropped past the budget; the sender's next save carries the strokes.
    if (++member.count > RATE_PER_SECOND || member.bytes > BYTES_PER_SECOND) return
    // Access can be taken away while the board is open (an invite removed).
    if (!this.#canAccess(member.principal, member.space)) {
      this.#leave(member)
      member.socket.close(WS_FORBIDDEN, 'no access to this board')
      return
    }
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    const msg = ClientMessage.safeParse(json)
    if (!msg.success) {
      this.#leave(member)
      member.socket.close(WS_POLICY, 'bad message')
      return
    }
    if (msg.data.type === 'scene') {
      const out = { type: 'scene', from: member.peer.id, elements: msg.data.elements }
      const to = msg.data.to
      this.#send(to ? [...room].filter((m) => m.peer.id === to) : room, out, member, true)
    } else {
      this.#send(room, { ...msg.data, from: member.peer.id }, member, true)
    }
  }

  /**
   * `live` messages (strokes, pointers) skip a receiver that is far behind rather than pile up
   * memory; saves catch it up. Who joined and left always goes, or "who's here" goes wrong.
   */
  #send(room: Iterable<Member>, message: unknown, except?: Member, live = false): void {
    const data = JSON.stringify(message)
    for (const m of room) {
      if (m === except) continue
      if (live && m.socket.bufferedAmount() > MAX_BUFFERED_BYTES) continue
      m.socket.send(data)
    }
  }

  #drop(pending: Pending): void {
    clearTimeout(pending.timer)
    pending.state = 'closed'
    this.#pending.delete(pending)
  }
}

function roomKey(space: string, id: string): string {
  return `${space}\u0000${id}`
}
