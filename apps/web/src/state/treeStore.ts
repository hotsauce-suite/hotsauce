import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api/client'
import type { Entry } from '../api/types'
import { dirname, isMarkdown } from '../lib/paths'

const key = (space: string, dir: string) => `${space}\n${dir}`

/**
 * Directory listings, fetched lazily one level at a time and shared by the sidebar,
 * folder pickers, Cmd-K and `[[` completion. Socket events refresh the loaded parents.
 */
export class TreeStore {
  private readonly dirs = new Map<string, Entry[]>()
  private readonly pending = new Map<string, Promise<Entry[]>>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(space: string, dir: string): Entry[] | undefined {
    return this.dirs.get(key(space, dir))
  }

  load(space: string, dir: string): Promise<Entry[]> {
    const k = key(space, dir)
    const cached = this.dirs.get(k)
    if (cached) return Promise.resolve(cached)
    return this.fetch(space, dir)
  }

  /** Refetches every loaded directory on the path to each changed file. */
  refreshPaths(space: string, paths: string[]): void {
    const dirs = new Set<string>()
    for (const path of paths) {
      for (let dir = dirname(path); dir; dir = dirname(dir)) {
        if (this.dirs.has(key(space, dir))) dirs.add(dir)
      }
    }
    for (const dir of dirs) void this.fetch(space, dir)
  }

  refreshAll(): void {
    for (const k of this.dirs.keys()) {
      const [space = '', dir = ''] = k.split('\n')
      void this.fetch(space, dir)
    }
  }

  /** Every markdown file seen so far, for instant title matches. */
  knownDocs(): Array<{ space: string; path: string }> {
    const docs: Array<{ space: string; path: string }> = []
    for (const [k, entries] of this.dirs) {
      const space = k.split('\n')[0] ?? ''
      for (const entry of entries) {
        if (entry.type === 'file' && isMarkdown(entry.path)) docs.push({ space, path: entry.path })
      }
    }
    return docs
  }

  private fetch(space: string, dir: string): Promise<Entry[]> {
    const k = key(space, dir)
    const inFlight = this.pending.get(k)
    if (inFlight) return inFlight
    const request = api
      .tree(space, dir)
      .then((entries) => {
        this.dirs.set(k, entries)
        this.emit()
        return entries
      })
      .catch((err: unknown) => {
        // A folder that vanished (moved, deleted elsewhere) just drops out of the tree.
        if (this.dirs.delete(k)) this.emit()
        throw err
      })
      .finally(() => this.pending.delete(k))
    this.pending.set(k, request)
    return request
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

/**
 * A free `untitled.md` (or `untitled-N.md`) path in `dir`, for "New doc". If the listing
 * can't load, an existing file at the path simply opens instead of being overwritten.
 */
export async function untitledDocPath(
  store: TreeStore,
  space: string,
  dir: string,
): Promise<string> {
  const siblings = await store.load(space, dir).catch((): Entry[] => [])
  const taken = new Set(siblings.map((entry) => entry.path))
  let path = `${dir}/untitled.md`
  for (let n = 2; taken.has(path); n++) path = `${dir}/untitled-${n}.md`
  return path
}

/** The listing for one directory, loading it on first use. */
export function useDirectory(store: TreeStore, space: string, dir: string, enabled = true) {
  const entries = useSyncExternalStore(store.subscribe, () => store.get(space, dir))
  useEffect(() => {
    if (enabled) store.load(space, dir).catch(() => {})
  }, [store, space, dir, enabled])
  return entries
}
