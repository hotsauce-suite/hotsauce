import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HearthError } from '../../errors.js'
import type { AudioStore } from './types.js'

/** Kept audio in a folder on the volume: `DATA_DIR/kept-audio/<key>`. For development and tests. */
export class LocalAudioStore implements AudioStore {
  readonly kind = 'local'
  readonly #root: string

  constructor(dataDir: string) {
    this.#root = path.join(dataDir, 'kept-audio')
  }

  async put(key: string, body: Readable, _size: number): Promise<void> {
    const file = this.#file(key)
    await mkdir(path.dirname(file), { recursive: true })
    await pipeline(body, createWriteStream(`${file}.tmp`))
    await rename(`${file}.tmp`, file)
  }

  async get(key: string) {
    const file = this.#file(key)
    try {
      const { size } = await stat(file)
      return { body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, size }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#file(key), { force: true })
  }

  /** Where `key` is on disk, for serving byte ranges of it (Hearth Clips playback). */
  pathOf(key: string): string {
    return this.#file(key)
  }

  #file(key: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.split('/').some((p) => p === '' || p === '..')) {
      throw new HearthError('bad_request', `Invalid audio key: ${key}`)
    }
    return path.join(this.#root, key)
  }
}
