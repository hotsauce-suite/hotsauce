/**
 * Syncs every known space on an interval: the fallback for hosts without webhooks (and for
 * missed deliveries). The next pass is scheduled only when the last one ends, so passes never
 * overlap however slow the host is.
 */
export class Poller {
  readonly #syncSpace: (space: string) => Promise<void>
  readonly #spaces: () => string[]
  readonly #intervalMs: number
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #stopped = true

  constructor(opts: {
    syncer: { syncSpace(space: string): Promise<void> }
    spaces: () => string[]
    intervalMs: number
    log?: (message: string) => void
  }) {
    this.#syncSpace = (space) => opts.syncer.syncSpace(space)
    this.#spaces = opts.spaces
    this.#intervalMs = opts.intervalMs
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

  /** One pass, one space at a time; a failing space is logged and doesn't stop the others. */
  async pollOnce(): Promise<void> {
    for (const space of this.#spaces()) {
      try {
        await this.#syncSpace(space)
      } catch (err) {
        this.#log(`sync of ${space} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
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
