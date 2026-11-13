import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface UpdateState {
  /** The admin's switch; null until they touch it, which means the default (on). */
  auto: boolean | null
  /** An update this server started and hasn't seen finish; `started` once the new version ran. */
  pending: { from: string; to: string; at: string; started?: boolean } | null
  /** The last update that didn't take, shown to admins until a later one does. */
  failed: { from: string; to: string; at: string } | null
  /** Versions that failed here; automatic updates skip them (an admin can still press Update). */
  skip: string[]
}

const EMPTY: UpdateState = { auto: null, pending: null, failed: null, skip: [] }

/** `DATA_DIR/updates.json`: survives restarts and updates, since the volume does. */
export class UpdateStore {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'updates.json')
  }

  get(): UpdateState {
    if (!existsSync(this.#file)) return { ...EMPTY, skip: [] }
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<UpdateState>
      return {
        auto: typeof raw.auto === 'boolean' ? raw.auto : null,
        pending: raw.pending ?? null,
        failed: raw.failed ?? null,
        skip: Array.isArray(raw.skip) ? raw.skip.filter((v) => typeof v === 'string') : [],
      }
    } catch {
      return { ...EMPTY, skip: [] }
    }
  }

  set(patch: Partial<UpdateState>): UpdateState {
    const next = { ...this.get(), ...patch }
    mkdirSync(path.dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(tmp, this.#file)
    return next
  }
}
