import type { Authenticator, Principal } from '../auth/index.js'
import { principalFromAuthMessage, WS_UNAUTHORIZED } from './handshake.js'

export type SyncEvent =
  | { type: 'changed'; space: string; headOid: string; paths: string[] }
  | { type: 'conflict'; space: string; path: string; ref: string }

/** What the broadcaster needs from a WebSocket. The `ws` library's socket provides all four. */
export interface ClientSocket {
  send(data: string): void
  close(code: number, reason: string): void
  ping(): void
  terminate(): void
}

/** Feed a socket's events back to the broadcaster through this. */
export interface Connection {
  receive(data: string): void
  pong(): void
  closed(): void
}

export { WS_UNAUTHORIZED } from './handshake.js'

const WS_GOING_AWAY = 1001

interface Client {
  socket: ClientSocket
  state: 'waiting' | 'authenticating' | 'ready' | 'closed'
  principal: Principal | null
  /** Answered the last ping. */
  alive: boolean
  authTimer: ReturnType<typeof setTimeout>
}

/**
 * Pushes sync events to WebSocket clients. Browsers can't set headers on a WebSocket and tokens
 * must stay out of URLs, so a client authenticates with its first message; it gets no events
 * before `{ type: 'ready' }`, and only events for spaces it can access.
 */
export class Broadcaster {
  readonly #auth: Authenticator
  readonly #canAccess: (p: Principal, space: string) => boolean
  readonly #authUrl: string
  readonly #authTimeoutMs: number
  readonly #heartbeatMs: number
  readonly #clients = new Set<Client>()
  #heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(opts: {
    auth: Authenticator
    spaces: { canAccess(p: Principal, space: string): boolean }
    publicUrl: string
    authTimeoutMs?: number
    heartbeatMs?: number
  }) {
    this.#auth = opts.auth
    this.#canAccess = (p, space) => opts.spaces.canAccess(p, space)
    this.#authUrl = new URL('/ws', opts.publicUrl).href
    this.#authTimeoutMs = opts.authTimeoutMs ?? 5_000
    this.#heartbeatMs = opts.heartbeatMs ?? 30_000
  }

  connect(socket: ClientSocket): Connection {
    const client: Client = {
      socket,
      state: 'waiting',
      principal: null,
      alive: true,
      authTimer: setTimeout(
        () => this.#reject(client, 'authentication timed out'),
        this.#authTimeoutMs,
      ),
    }
    this.#clients.add(client)
    return {
      receive: (data) => {
        if (client.state === 'waiting') void this.#authenticate(client, data)
      },
      pong: () => {
        client.alive = true
      },
      closed: () => this.#forget(client),
    }
  }

  broadcast(event: SyncEvent): void {
    const data = JSON.stringify(event)
    for (const client of this.#clients) {
      if (client.state !== 'ready' || client.principal === null) continue
      if (this.#canAccess(client.principal, event.space)) client.socket.send(data)
    }
  }

  /** Pings every client on an interval and drops the ones that stopped answering. */
  start(): void {
    if (this.#heartbeat) return
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        if (!client.alive) {
          this.#forget(client)
          client.socket.terminate()
          continue
        }
        client.alive = false
        client.socket.ping()
      }
    }, this.#heartbeatMs)
  }

  stop(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    for (const client of this.#clients) {
      this.#forget(client)
      client.socket.close(WS_GOING_AWAY, 'server shutting down')
    }
  }

  async #authenticate(client: Client, data: string): Promise<void> {
    client.state = 'authenticating'
    const principal = await principalFromAuthMessage(this.#auth, this.#authUrl, data)
    if (client.state !== 'authenticating') return // closed or timed out meanwhile
    if (principal === null) {
      this.#reject(client, 'unauthorized')
      return
    }
    clearTimeout(client.authTimer)
    client.principal = principal
    client.state = 'ready'
    client.socket.send(JSON.stringify({ type: 'ready' }))
  }

  #reject(client: Client, reason: string): void {
    if (client.state === 'ready' || client.state === 'closed') return
    this.#forget(client)
    client.socket.close(WS_UNAUTHORIZED, reason)
  }

  #forget(client: Client): void {
    clearTimeout(client.authTimer)
    client.state = 'closed'
    this.#clients.delete(client)
  }
}
