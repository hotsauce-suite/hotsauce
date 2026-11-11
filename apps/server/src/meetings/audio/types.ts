import type { Readable } from 'node:stream'

/**
 * Where kept meeting audio lives: never in Git (platform PRD §4). Keys look like
 * `meetings/<session id>/<track>.wav`; a pointer file in the owner's space records them.
 */
export interface AudioStore {
  readonly kind: 'local' | 'r2'
  /** Stores `size` bytes from `body` at `key`, replacing anything there. */
  put(key: string, body: Readable, size: number, contentType: string): Promise<void>
  /** The object's bytes, or null when there's nothing at `key`. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>
  /** Removes the object at `key`; nothing there is not an error. Hearth Clips' delete uses it. */
  delete(key: string): Promise<void>
}
