import { type FlyApi, HELPER_ROLE } from './fly.js'
import type { Release } from './releases.js'
import type { UpdateState, UpdateStore } from './store.js'
import { isNewer } from './version.js'

const CHECK_EVERY_MS = 6 * 60 * 60_000
/** An update that hasn't finished in this long failed somewhere nobody saw. */
const STALE_PENDING_MS = 30 * 60_000

export type UpdateMode = 'fly' | 'fly-needs-token' | 'manual'

export interface UpdateStatus {
  current: string
  latest: Release | null
  updateAvailable: boolean
  checkedAt: string | null
  mode: UpdateMode
  auto: boolean
  updating: UpdateState['pending']
  failed: UpdateState['failed']
}

export interface UpdaterOptions {
  current: string
  store: UpdateStore
  latestRelease: () => Promise<Release | null>
  /** Set on Fly with FLY_API_TOKEN; null elsewhere. */
  fly: FlyApi | null
  /** Fly's own variables when running there: FLY_APP_NAME, FLY_REGION, FLY_IMAGE_REF. */
  flyEnv: { app?: string; region?: string; imageRef?: string }
  /** The release images, e.g. ghcr.io/hotsauce-suite/hotsauce. */
  image: string
  publicUrl: string
  /** True while an update would cut something off (a meeting being recorded). */
  busy: () => boolean
  now?: () => Date
  log?: (line: string) => void
}

export class Updater {
  readonly #o: UpdaterOptions
  #latest: Release | null = null
  #checkedAt: Date | null = null
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: UpdaterOptions) {
    this.#o = opts
  }

  get #now(): Date {
    return this.#o.now?.() ?? new Date()
  }

  #log(line: string): void {
    ;(this.#o.log ?? console.log)(`updates: ${line}`)
  }

  mode(): UpdateMode {
    const { app, imageRef } = this.#o.flyEnv
    if (app && imageRef) return this.#o.fly ? 'fly' : 'fly-needs-token'
    return 'manual'
  }

  status(): UpdateStatus {
    const state = this.#o.store.get()
    return {
      current: this.#o.current,
      latest: this.#latest,
      updateAvailable: this.#latest !== null && isNewer(this.#latest.version, this.#o.current),
      checkedAt: this.#checkedAt?.toISOString() ?? null,
      mode: this.mode(),
      auto: state.auto ?? true,
      updating: state.pending,
      failed: state.failed,
    }
  }

  setAuto(on: boolean): UpdateStatus {
    this.#o.store.set({ auto: on })
    return this.status()
  }

  /** Asks GitHub for the newest release, at most every six hours unless `force`. */
  async check(force = false): Promise<Release | null> {
    const fresh =
      this.#checkedAt && this.#now.getTime() - this.#checkedAt.getTime() < CHECK_EVERY_MS
    if (fresh && !force) return this.#latest
    const latest = await this.#o.latestRelease()
    // A failed check keeps what we knew.
    if (latest) this.#latest = latest
    this.#checkedAt = this.#now
    return this.#latest
  }

  /**
   * Called once at startup: an update this server started either took (we're on the new version)
   * or was rolled back (we're still on the old one).
   */
  reconcile(): void {
    const state = this.#o.store.get()
    if (!state.pending) return
    const { pending } = state
    if (this.#o.current === pending.to) {
      this.#log(`now on ${pending.to}`)
      this.#o.store.set({ pending: null, failed: null })
      return
    }
    const startedAt = Date.parse(pending.at)
    const stale = !Number.isFinite(startedAt) || this.#now.getTime() - startedAt > STALE_PENDING_MS
    if (this.#o.current === pending.from && !stale) return
    this.#markFailed(state, pending)
  }

  #markFailed(state: UpdateState, pending: NonNullable<UpdateState['pending']>): void {
    this.#log(`update to ${pending.to} didn't take; still on ${this.#o.current}`)
    this.#o.store.set({
      pending: null,
      failed: pending,
      skip: [...new Set([...state.skip, pending.to])],
    })
  }

  /** Starts an update to the newest release (an admin's Update button, or the timer). */
  async start(): Promise<UpdateStatus> {
    const fly = this.#o.fly
    const { app, region, imageRef } = this.#o.flyEnv
    if (this.mode() !== 'fly' || !fly || !app || !imageRef) {
      throw new Error('This server can’t update itself; see the steps for your host')
    }
    const state = this.#o.store.get()
    if (state.pending) throw new Error(`Already updating to ${state.pending.to}`)
    const latest = await this.check(true)
    if (!latest || !isNewer(latest.version, this.#o.current)) {
      throw new Error('Already on the newest release')
    }
    const pending = { from: this.#o.current, to: latest.version, at: this.#now.toISOString() }
    this.#o.store.set({ pending })
    try {
      await fly.create({
        region: region ?? '',
        config: {
          // The helper runs the image we're on now, which is known to start.
          image: imageRef,
          auto_destroy: true,
          restart: { policy: 'no' },
          guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
          metadata: { role: HELPER_ROLE },
          init: { cmd: ['node', 'apps/server/dist/updates/helper-main.js'] },
          env: {
            HOTSAUCE_UPDATE_TARGET: `${this.#o.image}:${latest.version}`,
            HOTSAUCE_UPDATE_VERSION: latest.version,
            HOTSAUCE_UPDATE_PREVIOUS: imageRef,
            PUBLIC_URL: this.#o.publicUrl,
            FLY_APP_NAME: app,
          },
        },
      })
      this.#log(`started the update to ${latest.version}`)
    } catch (err) {
      this.#markFailed(this.#o.store.get(), pending)
      throw err
    }
    return this.status()
  }

  /** One automatic pass: check, then update if allowed and nothing would be cut off. */
  async tick(): Promise<void> {
    const state = this.#o.store.get()
    if (state.pending) {
      // The helper replaces this machine when it works; still being here long after means it
      // never got that far.
      const startedAt = Date.parse(state.pending.at)
      if (!Number.isFinite(startedAt) || this.#now.getTime() - startedAt > STALE_PENDING_MS) {
        this.#markFailed(state, state.pending)
      }
      return
    }
    const latest = await this.check()
    if (!latest || !isNewer(latest.version, this.#o.current)) return
    if (!(state.auto ?? true) || this.mode() !== 'fly') return
    if (state.skip.includes(latest.version)) return
    if (this.#o.busy()) {
      this.#log(`${latest.version} is out; waiting until no meeting is being recorded`)
      return
    }
    try {
      await this.start()
    } catch (err) {
      this.#log(`automatic update failed to start: ${err instanceof Error ? err.message : err}`)
    }
  }

  /** Checks a minute after startup, then every ten minutes (GitHub is asked every six hours). */
  startTimer(): void {
    if (this.#timer) return
    const run = () => void this.tick().catch((err) => this.#log(String(err)))
    setTimeout(run, 60_000).unref?.()
    this.#timer = setInterval(run, 10 * 60_000)
    this.#timer.unref?.()
  }

  stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
