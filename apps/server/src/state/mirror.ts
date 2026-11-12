import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { StateRemote } from './remote.js'

/**
 * The state mirror (docs/PLAN-cloudflare-deploy.md). On a host whose disk doesn't survive a
 * restart (a Cloudflare Container), it keeps every file under DATA_DIR that can't be rebuilt in a
 * small object store: restored before anything opens it, pushed every few seconds, flushed on
 * shutdown. What rebuilds from git or Google, and what is large and temporary, stays out
 * (`isDurable`), so a new feature's files are covered without changes here.
 */

/** Directories (relative to DATA_DIR) that are never mirrored, and never walked. */
const SKIP_DIRS = new Set([
  'repos',
  'kept-audio',
  'clips/uploads',
  'clips/work',
  'file-uploads',
  '.state-tmp',
])
const TMP_DIR = '.state-tmp'

/** Whether `rel` (a POSIX path relative to DATA_DIR) belongs in the mirror. */
export function isDurable(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false
  for (let i = 1; i <= parts.length; i++) {
    if (SKIP_DIRS.has(parts.slice(0, i).join('/'))) return false
  }
  const base = parts[parts.length - 1] as string
  // The search index rebuilds from git; SQLite's side files are folded in by the backup copy.
  if (rel === 'index.sqlite' || rel.startsWith('index.sqlite')) return false
  if (base.endsWith('-wal') || base.endsWith('-shm') || base.endsWith('-journal')) return false
  if (base.endsWith('.tmp') || base.includes('.tmp-')) return false
  // A live meeting's audio is large and grows by the second; its transcript and meta are kept.
  if (parts[0] === 'sessions' && base.endsWith('.pcm')) return false
  return true
}

const isSqlite = (rel: string) => /\.(sqlite|sqlite3|db)$/.test(rel)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

interface Seen {
  /** mtime and size of the file (and its WAL, for SQLite) when last hashed. */
  stamp: string
  hash: string
}

export interface MirrorOptions {
  dataDir: string
  remote: StateRemote
  intervalMs?: number
  log?: (message: string) => void
}

export class StateMirror {
  readonly #dir: string
  readonly #remote: StateRemote
  readonly #intervalMs: number
  readonly #log: (message: string) => void
  /** Keys the store holds, with the hash of what it holds (null: unknown). */
  readonly #remoteHashes = new Map<string, string | null>()
  readonly #seen = new Map<string, Seen>()
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> = Promise.resolve()

  constructor(opts: MirrorOptions) {
    this.#dir = opts.dataDir
    this.#remote = opts.remote
    this.#intervalMs = opts.intervalMs ?? 15_000
    this.#log = opts.log ?? ((m) => console.log(m))
  }

  /**
   * Writes every stored file that isn't on disk yet. Files already on disk win: they're newer (the
   * same container restarting to apply settings, say). Throws if the store can't be listed, since
   * starting without the organization's settings would look like a brand-new instance.
   */
  async restore(): Promise<number> {
    const keys = (await this.#remote.list()).filter(isDurable)
    let written = 0
    for (const key of keys) {
      const file = path.join(this.#dir, ...key.split('/'))
      if (await exists(file)) {
        this.#remoteHashes.set(key, null)
        continue
      }
      const body = await this.#remote.get(key)
      if (body === null) continue
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.restore-tmp`
      await writeFile(tmp, body)
      await rename(tmp, file)
      this.#remoteHashes.set(key, sha(body))
      written++
    }
    return written
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.sync(), this.#intervalMs)
    this.#timer.unref()
  }

  /** Stops the timer and pushes what changed since the last sync. */
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.sync()
  }

  /** One pass: push new and changed durable files, delete the ones that are gone. Never overlaps. */
  sync(): Promise<void> {
    this.#running = this.#running.then(
      () => this.#syncOnce(),
      () => this.#syncOnce(),
    )
    return this.#running
  }

  async #syncOnce(): Promise<void> {
    let local: string[]
    try {
      // A missing data directory (unmounted, being replaced) must never read as "everything was
      // deleted", which would empty the store.
      await stat(this.#dir)
      local = await this.#walk('')
    } catch (err) {
      this.#log(`state mirror: can't read ${this.#dir}: ${(err as Error).message}`)
      return
    }
    const present = new Set(local)
    for (const key of local) {
      try {
        await this.#push(key)
      } catch (err) {
        this.#log(`state mirror: ${key} not saved yet: ${(err as Error).message}`)
      }
    }
    for (const key of [...this.#remoteHashes.keys()]) {
      if (present.has(key)) continue
      try {
        await this.#remote.delete(key)
        this.#remoteHashes.delete(key)
        this.#seen.delete(key)
      } catch (err) {
        this.#log(`state mirror: ${key} not removed yet: ${(err as Error).message}`)
      }
    }
  }

  async #push(key: string): Promise<void> {
    const file = path.join(this.#dir, ...key.split('/'))
    const s = await stat(file)
    let stamp = `${s.mtimeMs}:${s.size}`
    if (isSqlite(key)) {
      const wal = await stat(`${file}-wal`).catch(() => null)
      if (wal) stamp += `:${wal.mtimeMs}:${wal.size}`
    }
    const seen = this.#seen.get(key)
    if (seen && seen.stamp === stamp && this.#remoteHashes.get(key) === seen.hash) return
    const body = isSqlite(key) ? await this.#sqliteCopy(file, key) : await readFile(file)
    const hash = sha(body)
    if (this.#remoteHashes.get(key) !== hash) {
      await this.#remote.put(key, body)
      this.#remoteHashes.set(key, hash)
    }
    this.#seen.set(key, { stamp, hash })
  }

  /** A consistent copy of a live SQLite database (WAL included), via SQLite's backup API. */
  async #sqliteCopy(file: string, key: string): Promise<Buffer> {
    const tmpDir = path.join(this.#dir, TMP_DIR)
    await mkdir(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, `${sha(Buffer.from(key)).slice(0, 16)}.sqlite`)
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try {
      await db.backup(tmp)
    } finally {
      db.close()
    }
    try {
      return await readFile(tmp)
    } finally {
      await rm(tmp, { force: true })
    }
  }

  async #walk(rel: string): Promise<string[]> {
    const dir = rel ? path.join(this.#dir, ...rel.split('/')) : this.#dir
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return []
        throw err
      },
    )
    const out: string[] = []
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(child)) out.push(...(await this.#walk(child)))
      } else if (e.isFile() && isDurable(child)) {
        out.push(child)
      }
    }
    return out
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
