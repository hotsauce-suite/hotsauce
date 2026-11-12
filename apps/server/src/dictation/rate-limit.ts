/** A sliding-window count per key: at most `limit` hits in any `windowMs`. In memory, per process. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>()

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  #lastSweep = 0

  /** Whether a hit would be allowed now, without recording one. */
  allows(key: string, now = Date.now()): boolean {
    return (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length < this.limit
  }

  /** Records a hit and says whether it is allowed; a refused hit isn't counted. */
  take(key: string, now = Date.now()): boolean {
    this.#sweep(now)
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(now)
    if (recent.length === 0) this.#hits.delete(key)
    else this.#hits.set(key, recent)
    return allowed
  }

  /** Keys nobody has hit within the window are dropped, at most once per window. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.windowMs && this.#hits.size < 10_000) return
    this.#lastSweep = now
    for (const [key, hits] of this.#hits) {
      if (!hits.some((t) => now - t < this.windowMs)) this.#hits.delete(key)
    }
  }
}
