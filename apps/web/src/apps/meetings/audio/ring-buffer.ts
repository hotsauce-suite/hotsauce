// The last five minutes of each track's PCM, in IndexedDB, so a dropped socket or a reloaded
// page can resend what the server never got (ARCHITECTURE §7.3, "Reconnect").
//
// Chunks are keyed [sessionId, track, end], where `end` is the byte offset just past the chunk
// in that track's stream. "Everything after byte N" and "everything older than five minutes"
// are then single key ranges. Storage is best-effort, like the notes draft: without IndexedDB
// (or on a quota error) every call still resolves and nothing is kept.

import type { Track } from '../../../api/types'
import { BYTES_PER_SECOND } from './pcm'

export const RING_SECONDS = 5 * 60
export const RING_BYTES_PER_TRACK = RING_SECONDS * BYTES_PER_SECOND

const DB_NAME = 'hearth-meetings-audio'
const STORE = 'chunks'

interface ChunkRecord {
  sessionId: string
  track: Track
  offset: number
  end: number
  bytes: ArrayBuffer
}

export interface RingChunk {
  /** Byte offset of `bytes[0]` in the track's stream. */
  offset: number
  bytes: Uint8Array
}

export interface AudioRingOptions {
  /** Defaults to the page's `indexedDB`; null keeps nothing. */
  factory?: IDBFactory | null
  name?: string
  maxBytesPerTrack?: number
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export class AudioRing {
  private db: Promise<IDBDatabase | null> | null = null
  private readonly maxBytes: number

  constructor(private readonly opts: AudioRingOptions = {}) {
    this.maxBytes = opts.maxBytesPerTrack ?? RING_BYTES_PER_TRACK
  }

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      const factory = this.opts.factory === undefined ? globalThis.indexedDB : this.opts.factory
      if (!factory) {
        resolve(null)
        return
      }
      try {
        const request = factory.open(this.opts.name ?? DB_NAME, 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE, { keyPath: ['sessionId', 'track', 'end'] })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return this.db
  }

  /** Stores `bytes` at `offset` and drops whatever is now older than the window. */
  async append(sessionId: string, track: Track, offset: number, bytes: Uint8Array): Promise<void> {
    const db = await this.open()
    if (!db) return
    const end = offset + bytes.byteLength
    const record: ChunkRecord = { sessionId, track, offset, end, bytes: bytes.slice().buffer }
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.put(record)
      const cutoff = end - this.maxBytes
      if (cutoff > 0)
        store.delete(IDBKeyRange.bound([sessionId, track, 0], [sessionId, track, cutoff]))
      await done(tx)
    } catch {
      // Quota or a closed database: the live stream matters more than the backup.
    }
  }

  /** The stored bytes in `[from, to)`, in order. Older bytes than the window are gone. */
  async read(sessionId: string, track: Track, from: number, to = Infinity): Promise<RingChunk[]> {
    const db = await this.open()
    if (!db || to <= from) return []
    try {
      const range = IDBKeyRange.bound(
        [sessionId, track, from],
        [sessionId, track, Infinity],
        true,
        false,
      )
      const tx = db.transaction(STORE, 'readonly')
      const records = await requestResult(
        tx.objectStore(STORE).getAll(range) as IDBRequest<ChunkRecord[]>,
      )
      const chunks: RingChunk[] = []
      for (const record of records) {
        const start = Math.max(record.offset, from)
        const stop = Math.min(record.end, to)
        if (stop <= start) continue
        chunks.push({
          offset: start,
          bytes: new Uint8Array(record.bytes, start - record.offset, stop - start),
        })
      }
      return chunks
    } catch {
      return []
    }
  }

  /** The byte offset just past the newest stored chunk; 0 when the track has none. */
  async end(sessionId: string, track: Track): Promise<number> {
    const db = await this.open()
    if (!db) return 0
    try {
      const range = IDBKeyRange.bound([sessionId, track, 0], [sessionId, track, Infinity])
      const tx = db.transaction(STORE, 'readonly')
      const cursor = await requestResult(tx.objectStore(STORE).openCursor(range, 'prev'))
      return (cursor?.value as ChunkRecord | undefined)?.end ?? 0
    } catch {
      return 0
    }
  }

  /** Forgets a session's audio (after Stop). */
  async clear(sessionId: string): Promise<void> {
    const db = await this.open()
    if (!db) return
    try {
      const tx = db.transaction(STORE, 'readwrite')
      // Arrays sort after strings and numbers, so [id, []] is above every [id, track, end].
      tx.objectStore(STORE).delete(IDBKeyRange.bound([sessionId], [sessionId, []]))
      await done(tx)
    } catch {
      // Best-effort.
    }
  }
}
