import type { ActivityCommit } from '../git/index.js'
import { buildUsageReport, type UsageReport, weekStarts } from './report.js'

/** How long a report is served from memory before it's counted again (U10). */
export const USAGE_CACHE_MS = 10 * 60_000
/** Weeks the report covers, the current one last (U2). */
export const USAGE_WEEKS = 12

export interface UsageSources {
  /** Every space with a clone on this server: team and personal (U3). */
  listSpaces(): Promise<string[]>
  activity(space: string, since: string): Promise<ActivityCommit[]>
  clipsSince(from: string): Array<{ id: string; ownerEmail: string; createdAt: string }>
  dictateDevices(): Array<{ lastUsedAt: string | null }>
  /** Hotsauce's own committer address (U5). */
  committerEmail: string
  now?: () => Date
  log?: (message: string) => void
}

/** The admin Usage page's numbers (docs/PLAN-app-usage.md), counted at most every 10 minutes. */
export class Usage {
  readonly #s: UsageSources
  #cached: { at: number; report: UsageReport } | null = null
  #running: Promise<UsageReport> | null = null

  constructor(sources: UsageSources) {
    this.#s = sources
  }

  async report(): Promise<UsageReport> {
    const now = (this.#s.now ?? (() => new Date()))()
    if (this.#cached && now.getTime() - this.#cached.at < USAGE_CACHE_MS) return this.#cached.report
    if (!this.#running) {
      this.#running = this.#count(now)
        .then((report) => {
          this.#cached = { at: now.getTime(), report }
          return report
        })
        .finally(() => {
          this.#running = null
        })
    }
    return this.#running
  }

  async #count(now: Date): Promise<UsageReport> {
    const since = `${weekStarts(now, USAGE_WEEKS)[0]}T00:00:00Z`
    const spaces: Array<{ space: string; commits: ActivityCommit[] }> = []
    // One space at a time: a big history must not crowd out members' saves.
    for (const space of await this.#s.listSpaces()) {
      try {
        spaces.push({ space, commits: await this.#s.activity(space, since) })
      } catch (err) {
        // A broken clone shouldn't hide every other space's numbers.
        ;(this.#s.log ?? console.log)(
          `usage: couldn't read the history of a space: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return buildUsageReport({
      now,
      weeks: USAGE_WEEKS,
      spaces,
      clips: this.#s.clipsSince(since),
      dictateDevices: this.#s.dictateDevices(),
      ignoreEmails: [this.#s.committerEmail],
    })
  }
}
