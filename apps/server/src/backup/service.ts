import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ObjectStore } from '../storage/s3.js'
import { backupsToDelete, dateOfKey, stampOf } from './retention.js'
import { BACKUP_TMP, createSnapshot } from './snapshot.js'

/**
 * Daily backups of DATA_DIR to the organization's bucket (docs/PLAN-backups-storage.md R4–R6).
 * Each backup is `<prefix><instance>/<stamp>.tar.gz`, then `<prefix><instance>/latest.json`.
 * After a good backup, old ones are pruned (14 daily, 8 weekly); after a failed one, nothing is.
 */
export interface BackupStatus {
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastKey?: string
  lastBytes?: number
  lastFiles?: number
  lastError?: string
  running?: boolean
}

export interface BackupInfo {
  key: string
  at: string
  size: number
}

export interface BackupServiceOptions {
  dataDir: string
  s3: ObjectStore
  /** Folder in the bucket, ending in `/`. */
  prefix: string
  /** Names this instance's folder (its public host), so instances can share a bucket. */
  instance: string
  /** UTC hour after which the day's backup runs. */
  hour: number
  /** Holds a space's git writes while its repository is copied (GitStore.withSpaceLocked). */
  lockSpace?: <T>(space: string, fn: () => Promise<T>) => Promise<T>
  now?: () => Date
  log?: (message: string) => void
}

const CHECK_MS = 15 * 60 * 1000
const STALE_MS = 25 * 60 * 60 * 1000
const FIRST_CHECK_MS = 3 * 60 * 1000
/** After a failed backup, wait this long before trying again on schedule. */
const RETRY_MS = 60 * 60 * 1000

export class BackupService {
  readonly #o: BackupServiceOptions
  readonly #now: () => Date
  readonly #log: (m: string) => void
  readonly #statusFile: string
  #timer: NodeJS.Timeout | null = null
  #first: NodeJS.Timeout | null = null
  #running: Promise<BackupStatus> | null = null
  #abort: AbortController | null = null

  constructor(opts: BackupServiceOptions) {
    this.#o = opts
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? ((m) => console.log(m))
    this.#statusFile = path.join(opts.dataDir, 'backup', 'status.json')
  }

  get folder(): string {
    return `${this.#o.prefix}${this.#o.instance}/`
  }

  async status(): Promise<BackupStatus> {
    const s = await readJson<BackupStatus>(this.#statusFile)
    return { ...s, running: this.#running !== null }
  }

  /** This instance's backups in the bucket, newest first. */
  async list(): Promise<BackupInfo[]> {
    const objects = await this.#o.s3.list(this.folder)
    return objects
      .map((o) => ({ o, at: dateOfKey(o.key) }))
      .filter((x): x is { o: (typeof objects)[number]; at: Date } => x.at !== null)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map(({ o, at }) => ({ key: o.key, at: at.toISOString(), size: o.size }))
  }

  /** Whether a backup is due now: past the hour with none yet today, or the last one is stale. */
  async due(): Promise<boolean> {
    const s = await this.status()
    const now = this.#now()
    const last = s.lastSuccessAt ? new Date(s.lastSuccessAt) : null
    // A failure waits an hour before the next try, so a bad key doesn't rebuild the archive every
    // 15 minutes all day.
    const tried = s.lastAttemptAt ? new Date(s.lastAttemptAt).getTime() : 0
    const failedLast = Boolean(s.lastError) && (!last || tried > last.getTime())
    if (failedLast && now.getTime() - tried < RETRY_MS) return false
    if (!last) return true
    if (now.getTime() - last.getTime() > STALE_MS) return true
    const todayAtHour = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      this.#o.hour,
    )
    return now.getTime() >= todayAtHour && last.getTime() < todayAtHour
  }

  /** Makes a backup now (one at a time: a second call joins the running one). */
  run(): Promise<BackupStatus> {
    if (!this.#running) {
      this.#running = this.#runOnce().finally(() => {
        this.#running = null
      })
    }
    return this.#running
  }

  start(): void {
    if (this.#timer) return
    const tick = () => {
      void this.due().then(
        (due) => (due ? this.run() : undefined),
        (err: unknown) => this.#log(`backup: ${(err as Error).message}`),
      )
    }
    this.#first = setTimeout(tick, FIRST_CHECK_MS)
    this.#first.unref()
    this.#timer = setInterval(tick, CHECK_MS)
    this.#timer.unref()
  }

  /**
   * Stops the timer and cancels a backup in progress (it's tried again after the restart), so a
   * deploy never waits on one: the server has seconds to shut down, and git must drain first.
   */
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    if (this.#first) clearTimeout(this.#first)
    this.#timer = null
    this.#first = null
    this.#abort?.abort(new Error('the server is shutting down'))
    await this.#running?.catch(() => undefined)
  }

  async #runOnce(): Promise<BackupStatus> {
    const now = this.#now()
    const prev = await readJson<BackupStatus>(this.#statusFile)
    const status: BackupStatus = { ...prev, lastAttemptAt: now.toISOString() }
    delete status.running
    let archive: string | null = null
    const abort = new AbortController()
    this.#abort = abort
    const { signal } = abort
    try {
      const stamp = stampOf(now)
      const snap = await createSnapshot(this.#o.dataDir, {
        now,
        name: stamp,
        signal,
        ...(this.#o.lockSpace ? { lockSpace: this.#o.lockSpace } : {}),
      })
      archive = snap.archive
      const size = (await stat(archive)).size
      const key = `${this.folder}${stamp}.tar.gz`
      await this.#o.s3.putFile(key, archive, size, 'application/gzip', signal)
      const latest = { key, at: now.toISOString(), size, files: snap.files }
      const body = new TextEncoder().encode(`${JSON.stringify(latest)}\n`)
      await this.#o.s3.put(`${this.folder}latest.json`, body, body.length, 'application/json')
      Object.assign(status, {
        lastSuccessAt: now.toISOString(),
        lastKey: key,
        lastBytes: size,
        lastFiles: snap.files,
      })
      delete status.lastError
      this.#log(`backup: ${key} (${snap.files} files, ${size} bytes)`)
      await this.#prune(now)
    } catch (err) {
      status.lastError = (err as Error).message
      this.#log(`backup failed: ${status.lastError}`)
    } finally {
      this.#abort = null
      if (archive) await rm(archive, { force: true })
      await rm(path.join(this.#o.dataDir, BACKUP_TMP), { recursive: true, force: true })
      await writeJson(this.#statusFile, status)
    }
    return status
  }

  async #prune(now: Date): Promise<void> {
    try {
      const all = (await this.list()).map((b) => ({ ...b, at: new Date(b.at) }))
      for (const old of backupsToDelete(all, { now })) {
        await this.#o.s3.delete(old.key)
        this.#log(`backup: pruned ${old.key}`)
      }
    } catch (err) {
      // A failed prune leaves extra backups, never fewer: try again after the next one.
      this.#log(`backup: pruning skipped: ${(err as Error).message}`)
    }
  }
}

async function readJson<T>(file: string): Promise<Partial<T>> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Partial<T>
  } catch {
    return {}
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, file)
}
