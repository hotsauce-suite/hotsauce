// Sends a recording's chunks as they're made (ARCHITECTURE §10.3), so Stop only waits for the last
// few seconds. Chunks go one at a time, in order, and each is retried until the server has it: a
// network blip only delays them. The server stores chunks by number, so a resend is harmless.

import { HearthApiError } from '../../../api/client'

export interface UploadState {
  /** Chunks made so far (the next chunk's number). */
  chunks: number
  /** Chunks the server has. */
  sent: number
  pendingBytes: number
  /** The last attempt failed and a retry is waiting. */
  retrying: boolean
  /** The server refused for good (the clip was deleted, or isn't ours): uploading has stopped. */
  fatal: Error | null
}

export type PutChunk = (seq: number, data: Blob) => Promise<void>

/** Errors worth retrying: no connection, timeouts, rate limits and the server's own failures. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof HearthApiError)) return true
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500
}

const MAX_DELAY_MS = 15_000

export class ChunkUploader {
  readonly #put: PutChunk
  readonly #sleep: (ms: number) => Promise<void>
  readonly #queue: Array<{ seq: number; data: Blob }> = []
  readonly #listeners = new Set<(state: UploadState) => void>()
  readonly #waiters = new Set<{ resolve: () => void; reject: (err: Error) => void }>()
  #chunks = 0
  #sent = 0
  #retrying = false
  #fatal: Error | null = null
  #pumping = false
  #stopped = false

  constructor(put: PutChunk, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.#put = put
    this.#sleep = sleep
  }

  get state(): UploadState {
    return {
      chunks: this.#chunks,
      sent: this.#sent,
      pendingBytes: this.#queue.reduce((n, c) => n + c.data.size, 0),
      retrying: this.#retrying,
      fatal: this.#fatal,
    }
  }

  subscribe(listener: (state: UploadState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Queues the next chunk. Empty blobs (MediaRecorder makes them while paused) are skipped. */
  add(data: Blob): void {
    if (this.#stopped || data.size === 0) return
    this.#queue.push({ seq: this.#chunks++, data })
    this.#emit()
    void this.#pump()
  }

  /** Resolves once every queued chunk is on the server; rejects if uploading stopped for good. */
  drain(): Promise<void> {
    if (this.#fatal) return Promise.reject(this.#fatal)
    if (this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.#waiters.add({ resolve, reject }))
  }

  /** Stops sending (the recording was cancelled). Queued chunks are dropped. */
  stop(): void {
    this.#stopped = true
    this.#queue.length = 0
    this.#emit()
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return
    this.#pumping = true
    let delay = 1000
    try {
      while (!this.#stopped && this.#queue.length > 0) {
        const next = this.#queue[0] as { seq: number; data: Blob }
        try {
          await this.#put(next.seq, next.data)
          this.#queue.shift()
          this.#sent++
          this.#retrying = false
          delay = 1000
          this.#emit()
        } catch (err) {
          if (!isRetryable(err)) {
            this.#fatal = err instanceof Error ? err : new Error(String(err))
            this.#stopped = true
            this.#emit()
            break
          }
          this.#retrying = true
          this.#emit()
          await this.#sleep(delay)
          delay = Math.min(delay * 2, MAX_DELAY_MS)
        }
      }
    } finally {
      this.#pumping = false
    }
    this.#settle()
  }

  #settle(): void {
    if (this.#fatal) {
      for (const w of this.#waiters) w.reject(this.#fatal)
      this.#waiters.clear()
    } else if (this.#queue.length === 0) {
      for (const w of this.#waiters) w.resolve()
      this.#waiters.clear()
    }
  }

  #emit(): void {
    const state = this.state
    for (const listener of this.#listeners) listener(state)
  }
}
