// Open windows pick up a new release on their own (docs/PLAN-reload-after-updates.md).
// The page notices the server runs another release and reloads at a safe moment.

declare const __HOTSAUCE_VERSION__: string | undefined

/** The release this build was made from (vite.config.ts `define`); '' in tests. */
export const BUILD_VERSION: string =
  typeof __HOTSAUCE_VERSION__ === 'string' ? __HOTSAUCE_VERSION__ : ''

export const CHECK_EVERY_MS = 10 * 60_000
export const IDLE_AFTER_MS = 2 * 60_000
export const AFTER_NAVIGATE_MS = 1_500
export const RETRY_AFTER_MS = 30 * 60_000
export const WORKER_WAIT_MS = 10_000

/** What the page remembers across the reload (sessionStorage). */
export const RELOAD_KEY = 'hotsauce:update-reload'

export type Moment = 'hidden' | 'idle' | 'navigate'

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface UpdateWatchDeps {
  buildVersion: string
  /** The server's release, or null when it can't be asked (offline). */
  serverVersion: () => Promise<string | null>
  /** Why reloading now would lose something, or null (lib/safeToReload). */
  blocker: () => string | null
  /** Fetch the new build into the service worker before reloading (R5). */
  prepare: () => Promise<void>
  reload: () => void
  storage: KeyStore | null
  now: () => number
}

interface Attempt {
  version: string
  at: number
}

function readAttempt(storage: KeyStore | null): Attempt | null {
  try {
    const raw = storage?.getItem(RELOAD_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Attempt>
    return typeof v.version === 'string' && typeof v.at === 'number'
      ? { version: v.version, at: v.at }
      : null
  } catch {
    return null
  }
}

/**
 * The page's side of an update: `check()` asks the server, `moment()` is a chance to reload.
 * A different release (newer or a rollback) waits for a moment when nothing would be lost.
 */
export class UpdateWatch {
  /** The server's release when it differs from this build's. */
  waiting: string | null = null
  private reloading = false

  constructor(private deps: UpdateWatchDeps) {}

  async check(): Promise<void> {
    const { buildVersion } = this.deps
    if (!buildVersion) return
    let version: string | null = null
    try {
      version = await this.deps.serverVersion()
    } catch {
      return
    }
    if (!version) return
    this.waiting = version !== buildVersion ? version : null
  }

  /** Tries to reload into the waiting release; true when it did. */
  async moment(_kind: Moment): Promise<boolean> {
    const target = this.waiting
    if (!target || this.reloading) return false
    const last = readAttempt(this.deps.storage)
    // Already reloaded for this release and still on the old build: don't loop (R6).
    if (last && last.version === target && this.deps.now() - last.at < RETRY_AFTER_MS) return false
    if (this.deps.blocker() !== null) return false
    this.reloading = true
    try {
      await this.deps.prepare()
    } catch {
      // Reloading still picks up whatever the browser has.
    }
    // Someone may have started typing or recording while the build downloaded.
    if (this.deps.blocker() !== null) {
      this.reloading = false
      return false
    }
    try {
      this.deps.storage?.setItem(
        RELOAD_KEY,
        JSON.stringify({ version: target, at: this.deps.now() } satisfies Attempt),
      )
    } catch {
      // No storage: the loop guard is lost, the reload still happens.
    }
    this.deps.reload()
    return true
  }
}

/**
 * After the page loaded: the release it reloaded into, when that reload brought it (R7), so the
 * shell can say so once. Clears the note either way once the build matches.
 */
export function takeUpdatedVersion(buildVersion: string, storage: KeyStore | null): string | null {
  const last = readAttempt(storage)
  if (!last || !buildVersion || last.version !== buildVersion) return null
  try {
    storage?.removeItem(RELOAD_KEY)
  } catch {
    // Nothing to clear.
  }
  return last.version
}

/**
 * Asks the service worker for the new build and waits until it controls the page, or `ms` pass.
 * The worker takes over on install (skipWaiting + clientsClaim, vite.config.ts).
 */
export async function fetchNewWorker(
  container: ServiceWorkerContainer | undefined,
  ms = WORKER_WAIT_MS,
): Promise<void> {
  if (!container) return
  const reg = await container.getRegistration()
  if (!reg) return
  const before = container.controller
  const changed = new Promise<void>((resolve) => {
    container.addEventListener('controllerchange', () => resolve(), { once: true })
  })
  await Promise.race([
    reg.update().then(
      async () => {
        // No new worker found: nothing to wait for.
        if (!reg.installing && !reg.waiting && container.controller === before) return
        await changed
      },
      () => {},
    ),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}
