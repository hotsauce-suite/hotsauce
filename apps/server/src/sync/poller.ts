/**
 * How many spaces one pass syncs at once. Each sync is mostly a `git fetch` waiting on the host,
 * and spaces don't share locks, so a pass over many members' spaces takes about as long as its
 * slowest few, not the sum of them all (one at a time, 40 spaces took ~6 s).
 */
export const POLL_CONCURRENCY = 8

/**
 * Syncs every known space on an interval: the fallback for hosts without webhooks (and for
 * missed deliveries). The next pass is scheduled only when the last one ends, so passes never
 * overlap however slow the host is.
 */
export class Poller {
  readonly #syncSpace: (space: string) => Promise<void>
  readonly #spaces: () => string[]
  readonly #intervalMs: number
  readonly #concurrency: number
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #stopped = true

  constructor(opts: {
    syncer: { syncSpace(space: string): Promise<void> }
    spaces: () => string[]
    intervalMs: number
    log?: (message: string) => void
    concurrency?: number
  }) {
    this.#syncSpace = (space) => opts.syncer.syncSpace(space)
    this.#spaces = opts.spaces
    this.#intervalMs = opts.intervalMs
    this.#concurrency = Math.max(1, opts.concurrency ?? POLL_CONCURRENCY)
    this.#log = opts.log ?? console.error
  }

  /** Starts with an immediate pass. */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#schedule(0)
  }

  /** Stops scheduling and waits for a pass in progress to finish. */
  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    await this.#running
  }

  /**
   * One pass over every space, a few at a time, in list order (the team space first); a failing
   * space is logged and doesn't stop the others.
   */
  async pollOnce(): Promise<void> {
    const queue = [...this.#spaces()]
    const worker = async () => {
      for (let space = queue.shift(); space !== undefined; space = queue.shift()) {
        try {
          await this.#syncSpace(space)
        } catch (err) {
          this.#log(`sync of ${space} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, queue.length) }, worker))
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#running = this.pollOnce().finally(() => {
        this.#running = null
        if (!this.#stopped) this.#schedule(this.#intervalMs)
      })
    }, delayMs)
  }
}
