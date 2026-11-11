import { getAuthHeaders } from './client'
import type { ServerEvent } from './types'

export type ChangedEvent = Extract<ServerEvent, { type: 'changed' }>
export type ConflictEvent = Extract<ServerEvent, { type: 'conflict' }>

export type SocketAuthMessage = { type: 'auth'; token: string } | { type: 'auth'; devUser: string }

const MAX_BACKOFF_MS = 30_000
/** Close code the server uses when the auth message is missing or invalid. */
export const AUTH_FAILED_CLOSE_CODE = 4401

export function socketUrl(): string {
  const url = new URL('/ws', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * Browsers can't set headers on a WebSocket and query strings end up in access logs, so the
 * credentials go in the first message instead. Derived from the same headers HTTP calls use,
 * fetched fresh on every (re)connect because Clerk tokens are short-lived.
 */
export function authMessage(headers: Record<string, string>): SocketAuthMessage | null {
  const bearer = headers.authorization ?? headers.Authorization
  if (bearer?.startsWith('Bearer ')) return { type: 'auth', token: bearer.slice('Bearer '.length) }
  const devUser = headers['x-hearth-dev-user']
  if (devUser) return { type: 'auth', devUser }
  return null
}

export class HearthSocket {
  private socket: WebSocket | null = null
  private stopped = true
  private attempts = 0
  private everReady = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly changed = new Set<(event: ChangedEvent) => void>()
  private readonly conflict = new Set<(event: ConflictEvent) => void>()
  private readonly reconnect = new Set<() => void>()

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  onChanged(listener: (event: ChangedEvent) => void): () => void {
    this.changed.add(listener)
    return () => this.changed.delete(listener)
  }

  onConflict(listener: (event: ConflictEvent) => void): () => void {
    this.conflict.add(listener)
    return () => this.conflict.delete(listener)
  }

  /** Fires when a dropped connection is ready again; events may have been missed meanwhile. */
  onReconnect(listener: () => void): () => void {
    this.reconnect.add(listener)
    return () => this.reconnect.delete(listener)
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(socketUrl())
    this.socket = socket
    socket.addEventListener('open', () => void this.authenticate(socket))
    socket.addEventListener('message', (event) => this.handle(event.data))
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.scheduleReconnect()
    })
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    const message = authMessage(await getAuthHeaders())
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
    if (!message) {
      socket.close()
      return
    }
    socket.send(JSON.stringify(message))
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts)
    this.attempts += 1
    this.timer = setTimeout(() => this.connect(), delay)
  }

  private handle(data: unknown): void {
    if (typeof data !== 'string') return
    let event: ServerEvent | { type: 'ready' }
    try {
      event = JSON.parse(data) as ServerEvent | { type: 'ready' }
    } catch {
      return
    }
    if (event.type === 'ready') {
      this.attempts = 0
      if (this.everReady) for (const listener of this.reconnect) listener()
      this.everReady = true
    }
    if (event.type === 'changed') for (const listener of this.changed) listener(event)
    if (event.type === 'conflict') for (const listener of this.conflict) listener(event)
  }
}

export const hearthSocket = new HearthSocket()
