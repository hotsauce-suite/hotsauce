// Live drawing together on one board (ARCHITECTURE §15.5), kept apart from Excalidraw so it can
// be tested on its own. It sends what this editor changed (only elements whose version moved
// since it last sent or saw them) and where the pointer is, and hands on what others send.
// Saving is not its job: BoardSession saves, and every editor's save merges by element version.

import { BLOCKED_ELEMENT_TYPES, type BoardElement } from '@hearth/format'
import { authMessage, type SocketAuthMessage } from '../../api/ws'

/** Someone else on the board. */
export interface Peer {
  id: string
  name: string
  email: string
}

export interface PointerUpdate {
  x: number
  y: number
  button?: 'down' | 'up'
  /** The laser pointer draws a fading trail for the others. */
  tool?: 'pointer' | 'laser'
}

export interface CollabEvents {
  /** Elements someone else changed. */
  scene(elements: BoardElement[], from: string): void
  pointer(from: string, pointer: PointerUpdate): void
  /** Everyone else on the board now. */
  peers(peers: Peer[]): void
}

export interface CollabIO {
  open(url: string): CollabSocket
  auth(): Promise<SocketAuthMessage | null>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** The parts of a browser WebSocket used here. */
export interface CollabSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open', fn: () => void): void
  addEventListener(type: 'close', fn: (e: { code?: number }) => void): void
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void
}

const OPEN = 1
/** Changes are batched this long, so a drag sends ~25 messages a second, not one per frame. */
export const SEND_EVERY_MS = 40
/** Pointer moves at most this often. */
export const POINTER_EVERY_MS = 50
/** A batch is split well before the server's frame limit (256 KiB), counted in UTF-8 bytes. */
export const MAX_BATCH_BYTES = 200_000
const MAX_BACKOFF_MS = 30_000
/** The server refused for good (no access, a bad or too-big message): no reconnecting. */
const FINAL_CLOSE = new Set([4403, 1008, 1009])
/** The board is full: try again, slowly. */
const FULL = 1013

const encoder = new TextEncoder()
const allowed = (el: BoardElement) => !BLOCKED_ELEMENT_TYPES.has(el.type)

const key = (el: BoardElement) => `${el.version}:${el.versionNonce ?? 0}`

export class BoardCollab {
  readonly #url: string
  readonly #io: CollabIO
  readonly #on: CollabEvents
  #socket: CollabSocket | null = null
  #ready = false
  #closed = false
  #attempts = 0
  #retry: unknown = null
  /** The version of each element this editor last sent or received. */
  readonly #known = new Map<string, string>()
  #pending: readonly BoardElement[] | null = null
  /** The editor's elements as last handed over, to catch up someone who joins. */
  #latest: readonly BoardElement[] = []
  /** Elements this editor changed since its last save, for someone who joins before it saves. */
  readonly #unsaved = new Set<string>()
  #sendTimer: unknown = null
  #pointer: PointerUpdate | null = null
  #pointerTimer: unknown = null
  readonly #peers = new Map<string, Peer>()

  constructor(url: string, io: CollabIO, on: CollabEvents) {
    this.#url = url
    this.#io = io
    this.#on = on
  }

  /** `elements` is what the editor has when it opens: nothing in it needs sending. */
  start(elements: readonly BoardElement[]): void {
    for (const el of elements) this.#known.set(el.id, key(el))
    this.#latest = elements
    this.#connect()
  }

  close(): void {
    this.#closed = true
    for (const t of [this.#retry, this.#sendTimer, this.#pointerTimer])
      if (t !== null) this.#io.clearTimer(t)
    this.#retry = this.#sendTimer = this.#pointerTimer = null
    this.#socket?.close()
    this.#socket = null
  }

  /** How many other people are on the board. */
  get peerCount(): number {
    return this.#peers.size
  }

  /** The editor's scene changed: send what moved, soon. */
  changed(elements: readonly BoardElement[]): void {
    if (this.#closed) return
    this.#pending = elements
    this.#latest = elements
    for (const el of elements) if (this.#known.get(el.id) !== key(el)) this.#unsaved.add(el.id)
    if (this.#sendTimer !== null) return
    this.#sendTimer = this.#io.setTimer(() => {
      this.#sendTimer = null
      this.#flush()
    }, SEND_EVERY_MS)
  }

  /** Elements from someone else that the editor now shows: never send them back. */
  seen(elements: readonly BoardElement[]): void {
    for (const el of elements) this.#known.set(el.id, key(el))
  }

  /** The board was saved with everything this editor had: a joiner gets it from the save. */
  saved(): void {
    this.#unsaved.clear()
  }

  pointer(update: PointerUpdate): void {
    if (this.#closed || this.#peers.size === 0) return
    this.#pointer = update
    if (this.#pointerTimer !== null) return
    this.#sendPointer()
    this.#pointerTimer = this.#io.setTimer(() => {
      this.#pointerTimer = null
      if (this.#pointer) this.#sendPointer()
    }, POINTER_EVERY_MS)
  }

  #sendPointer(): void {
    const p = this.#pointer
    this.#pointer = null
    if (p) this.#send({ type: 'pointer', ...p })
  }

  #flush(): void {
    const elements = this.#pending
    this.#pending = null
    if (!elements) return
    const changed = elements.filter((el) => allowed(el) && this.#known.get(el.id) !== key(el))
    if (changed.length === 0) return
    // Alone on the board: nothing to send, and nothing marked sent, so it goes once someone comes.
    if (!this.#ready || this.#peers.size === 0) return
    this.#sendBatches(changed, true)
  }

  /**
   * Sends elements in frames under the server's limit. `markKnown`: what went out is not sent
   * again; a closed socket leaves it for the next try.
   */
  #sendBatches(elements: readonly BoardElement[], markKnown: boolean, to?: string): void {
    let batch: BoardElement[] = []
    let size = 0
    const send = () => {
      if (batch.length === 0) return
      const sent = this.#send({ type: 'scene', elements: batch, ...(to ? { to } : {}) })
      if (sent && markKnown) for (const el of batch) this.#known.set(el.id, key(el))
      batch = []
      size = 0
    }
    for (const el of elements) {
      const bytes = encoder.encode(JSON.stringify(el)).length
      if (bytes > MAX_BATCH_BYTES) {
        // Too big to go live (a huge freehand stroke): the next save carries it.
        if (markKnown) this.#known.set(el.id, key(el))
        continue
      }
      if (size + bytes > MAX_BATCH_BYTES || batch.length >= 1_000) send()
      batch.push(el)
      size += bytes + 1
    }
    send()
  }

  /** Back after a dropped connection: what changed since the last save goes to everyone. */
  #resend(): void {
    for (const id of this.#unsaved) this.#known.delete(id)
    this.changed(this.#latest)
  }

  /** Someone joined: what this editor drew since its last save goes to them, and only them. */
  #catchUp(peer: string): void {
    if (this.#unsaved.size === 0) return
    // Only what already went out to the others; the rest goes to everyone with the next batch.
    const mine = this.#latest.filter(
      (el) => allowed(el) && this.#unsaved.has(el.id) && this.#known.get(el.id) === key(el),
    )
    this.#sendBatches(mine, false, peer)
  }

  #send(message: unknown): boolean {
    const socket = this.#socket
    if (!socket || !this.#ready || socket.readyState !== OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  #connect(): void {
    if (this.#closed) return
    const socket = this.#io.open(this.#url)
    this.#socket = socket
    socket.addEventListener('open', () => {
      void this.#io.auth().then((message) => {
        if (this.#socket !== socket || socket.readyState !== OPEN) return
        if (!message) {
          socket.close()
          return
        }
        socket.send(JSON.stringify(message))
      })
    })
    socket.addEventListener('message', (e) => this.#receive(e.data))
    socket.addEventListener('close', (e) => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#ready = false
      if (this.#peers.size > 0) {
        this.#peers.clear()
        this.#on.peers([])
      }
      if (this.#closed) return
      if (e?.code !== undefined && FINAL_CLOSE.has(e.code)) return
      const delay =
        e?.code === FULL ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#attempts)
      this.#attempts += 1
      this.#retry = this.#io.setTimer(() => {
        this.#retry = null
        this.#connect()
      }, delay)
    })
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready': {
        this.#ready = true
        this.#attempts = 0
        this.#peers.clear()
        for (const p of (msg.peers as Peer[] | undefined) ?? []) this.#peers.set(p.id, p)
        this.#on.peers([...this.#peers.values()])
        this.#resend()
        break
      }
      case 'join': {
        const peer = msg.peer as Peer
        this.#peers.set(peer.id, peer)
        this.#on.peers([...this.#peers.values()])
        // Anything drawn since the last save (alone or not) goes to them now.
        this.#catchUp(peer.id)
        // And whatever is waiting for the next batch goes to everyone, them included.
        this.changed(this.#latest)
        break
      }
      case 'leave': {
        if (this.#peers.delete(String(msg.id))) this.#on.peers([...this.#peers.values()])
        break
      }
      case 'scene': {
        const list = msg.elements as BoardElement[]
        if (!Array.isArray(list)) break
        const elements = list.filter(
          (el) => el && typeof el.id === 'string' && typeof el.type === 'string' && allowed(el),
        )
        if (elements.length > 0) this.#on.scene(elements, String(msg.from))
        break
      }
      case 'pointer': {
        const { x, y, button, tool } = msg as unknown as PointerUpdate
        if (Number.isFinite(x) && Number.isFinite(y))
          this.#on.pointer(String(msg.from), {
            x,
            y,
            ...(button === 'down' || button === 'up' ? { button } : {}),
            ...(tool === 'laser' ? { tool } : {}),
          })
        break
      }
    }
  }
}

/** The socket URL for one board. */
export function boardSocketUrl(space: string, id: string): string {
  const url = new URL(
    `/ws/boards/${encodeURIComponent(space)}/${encodeURIComponent(id)}`,
    window.location.origin,
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** The browser's WebSocket and the app's sign-in, for BoardCollab. */
export function browserCollabIO(getHeaders: () => Promise<Record<string, string>>): CollabIO {
  return {
    open: (url) => new WebSocket(url) as unknown as CollabSocket,
    auth: async () => authMessage(await getHeaders()),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }
}

/** A stable color per person, from their email. */
export function peerColor(email: string): { background: string; stroke: string } {
  let h = 0
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hue = h % 360
  return { background: `hsl(${hue} 80% 85%)`, stroke: `hsl(${hue} 65% 40%)` }
}
