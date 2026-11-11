import { HearthError } from '../errors.js'
import type { GitStore } from '../git/index.js'
import { KeyedMutex } from '../git/mutex.js'
import type { Index, Indexer } from '../index/index.js'
import type { SyncEvent } from './broadcaster.js'

export type SyncGit = Pick<
  GitStore,
  'sync' | 'headOid' | 'changedPaths' | 'listAll' | 'listConflicts'
>

/**
 * The one path from "HEAD moved" to "the index and every open client know": after a sync with
 * the host (webhook or poll), and after every commit Hearth makes itself.
 */
export class Syncer {
  readonly #git: SyncGit
  readonly #index: Index
  readonly #indexer: Indexer
  readonly #broadcast: (event: SyncEvent) => void
  readonly #locks = new KeyedMutex()

  constructor(opts: {
    git: SyncGit
    index: Index
    indexer: Indexer
    broadcaster: { broadcast(event: SyncEvent): void }
  }) {
    this.#git = opts.git
    this.#index = opts.index
    this.#indexer = opts.indexer
    this.#broadcast = (event) => opts.broadcaster.broadcast(event)
  }

  /** Fetches and pushes the space, then indexes and announces whatever changed. */
  async syncSpace(space: string): Promise<void> {
    await this.#git.sync(space)
    await this.afterHeadChanged(space)
    await this.#reconcileConflicts(space)
  }

  /**
   * Indexes everything that changed between the space's recorded sync point and HEAD, records
   * HEAD as the new sync point, and broadcasts `changed`. Indexing from the sync point rather
   * than from what one commit touched matters: a Hearth commit fast-forwards over outside pushes
   * first, and those files would otherwise never be indexed.
   */
  afterHeadChanged(space: string): Promise<void> {
    return this.#locks.run(space, async () => {
      const head = await this.#headOrNull(space)
      if (head === null) return
      const last = this.#index.getSyncState(space)?.headOid ?? null
      if (last === head) return
      const paths = await this.#indexChanges(space, last, head)
      // HEAD as read before indexing, so the sync point is never ahead of what was indexed.
      this.#index.setSyncState(space, head)
      this.#broadcast({ type: 'changed', space, headOid: head, paths })
    })
  }

  /** A save or a resolution parked a version on a conflict branch. */
  conflictCreated(space: string, ref: string, path: string): void {
    this.#index.addConflict(space, ref, path)
    this.#broadcast({ type: 'conflict', space, path, ref })
  }

  conflictResolved(space: string, ref: string): void {
    this.#index.removeConflict(space, ref)
  }

  async #indexChanges(space: string, last: string | null, head: string): Promise<string[]> {
    if (last !== null) {
      let paths: string[] | null = null
      try {
        paths = await this.#git.changedPaths(space, last, head)
      } catch (err) {
        // The recorded commit is gone (say, a re-clone after a history rewrite): start over.
        if (!(err instanceof HearthError && err.code === 'not_found')) throw err
      }
      if (paths !== null) {
        await this.#indexer.incremental(space, paths)
        return paths
      }
    }
    const paths = (await this.#git.listAll(space)).map((e) => e.path)
    await this.#indexer.full(space)
    return paths
  }

  /** Conflicts can also appear during a sync (a rebase of unpushed commits); announce new ones. */
  async #reconcileConflicts(space: string): Promise<void> {
    const live = await this.#git.listConflicts(space)
    const known = new Set(this.#index.listConflicts(space).map((c) => c.ref))
    for (const conflict of live) {
      if (!known.has(conflict.ref)) this.conflictCreated(space, conflict.ref, conflict.path)
    }
    const liveRefs = new Set(live.map((c) => c.ref))
    for (const ref of known) {
      if (!liveRefs.has(ref)) this.conflictResolved(space, ref)
    }
  }

  async #headOrNull(space: string): Promise<string | null> {
    try {
      return await this.#git.headOid(space)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
  }
}
