/** A sliding-window count per key: at most `limit` hits in any `windowMs`. In memory, per process. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>()

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Records a hit and says whether it is allowed; a refused hit isn't counted. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(now)
    if (recent.length === 0) this.#hits.delete(key)
    else this.#hits.set(key, recent)
    return allowed
  }
}
