import { HearthError } from '../errors.js'
import type { Index, IndexFile } from './db.js'
import { isIndexable } from './extract.js'

// Structural slice of GitStore (ARCHITECTURE §3.2), copied exactly so the real class satisfies it.
// Replace with an import from ../git once that module lands.
export interface Entry {
  path: string
  type: 'file' | 'dir'
  size?: number
  oid?: string
}

export interface GitReader {
  listAll(space: string): Promise<Entry[]>
  readFile(space: string, path: string, ref?: string): Promise<{ content: string; blobOid: string }>
  headOid(space: string): Promise<string>
}

// Bounds concurrent `git` processes during a full walk.
const READ_CONCURRENCY = 8

export class Indexer {
  readonly #git: GitReader
  readonly #index: Index

  constructor(git: GitReader, index: Index) {
    this.#git = git
    this.#index = index
  }

  /** Rebuilds the space's index from the working tree. A space with no commits indexes as empty. */
  async full(space: string): Promise<void> {
    // Read HEAD first so the recorded sync point is never ahead of what was indexed.
    let head: string
    try {
      head = await this.#git.headOid(space)
    } catch (err) {
      if (!(err instanceof HearthError && err.code === 'not_found')) throw err
      this.#index.reindexSpace(space, [])
      return
    }
    const entries = await this.#git.listAll(space)
    const paths = entries.filter((e) => e.type === 'file' && isIndexable(e.path)).map((e) => e.path)
    const { found } = await this.#readMany(space, paths)
    this.#index.reindexSpace(space, found)
    this.#index.setSyncState(space, head)
  }

  /** Re-reads the given changed paths: upserts the ones that exist, removes the ones that don't. */
  async incremental(space: string, paths: string[]): Promise<void> {
    const head = await this.#git.headOid(space)
    const wanted = [...new Set(paths)].filter(isIndexable)
    const { found, missing } = await this.#readMany(space, wanted)
    this.#index.upsertFiles(space, found)
    this.#index.removeFiles(space, missing)
    this.#index.setSyncState(space, head)
  }

  async #readMany(
    space: string,
    paths: string[],
  ): Promise<{ found: IndexFile[]; missing: string[] }> {
    const found: IndexFile[] = []
    const missing: string[] = []
    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      await Promise.all(
        paths.slice(i, i + READ_CONCURRENCY).map(async (path) => {
          try {
            const { content, blobOid } = await this.#git.readFile(space, path)
            found.push({ path, content, blobOid })
          } catch (err) {
            if (err instanceof HearthError && err.code === 'not_found') missing.push(path)
            else throw err
          }
        }),
      )
    }
    return { found, missing }
  }
}
