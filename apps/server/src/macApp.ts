import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * The Mac app is built on a Mac, so the release image can't contain it. Each build is published
 * on its own GitHub release, tagged `mac-app-<build>` (a prerelease, so the updater never takes
 * it for a Hotsauce release; releases are immutable, so a build can't be replaced in place). A
 * server without a build of its own finds the newest one, fetches it and keeps a copy on its
 * disk. Builds from before were on the one `mac-app` release, still used when no other exists.
 */
export const MAC_APP_RELEASES = 'https://github.com/hotsauce-suite/hotsauce/releases/download'
export const MAC_APP_RELEASES_API =
  'https://api.github.com/repos/hotsauce-suite/hotsauce/releases?per_page=100'
const LEGACY_TAG = 'mac-app'

interface GitHubRelease {
  tag_name?: unknown
  draft?: unknown
}

/** The tag of the newest Mac app build among GitHub's releases: `mac-app-<highest build>`. */
export function newestMacRelease(releases: unknown): string {
  let best: { tag: string; build: number } | null = null
  for (const release of Array.isArray(releases) ? (releases as GitHubRelease[]) : []) {
    if (release.draft === true || typeof release.tag_name !== 'string') continue
    const m = /^mac-app-(\d+)$/.exec(release.tag_name)
    if (!m) continue
    const build = Number(m[1])
    if (!best || build > best.build) best = { tag: release.tag_name, build }
  }
  return best?.tag ?? LEGACY_TAG
}

/**
 * What the newest Mac app is, published beside it (apps/dictate-mac/scripts/build-app.sh):
 * `{ "version", "build", "reportsVersion" }`. Settings and the app itself compare against it
 * (docs/PLAN-mac-version-and-whats-new.md, M1, M2).
 */
export const MAC_APP_INFO = 'mac-app.json'

/** The names the app is offered under, including old ones in links already shared. */
export function releaseAsset(name: string): string | null {
  if (name === MAC_APP_INFO) return MAC_APP_INFO
  const m = /^(Hotsauce|Hearth|HearthDictate)\.(dmg|zip)$/.exec(name)
  return m ? `Hotsauce.${m[2]}` : null
}

/** The Content-Type a release asset is served with. */
export function assetType(asset: string): string {
  if (asset.endsWith('.json')) return 'application/json'
  return asset.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/zip'
}

const MAX_BYTES = 400 * 1024 * 1024

export class MacAppDownloads {
  readonly #dir: string
  /** A fixed place to fetch from (tests); otherwise the newest release, looked up. */
  readonly #base: string | null
  readonly #api: string
  #tag: { name: string; at: number } | null = null
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #maxAgeMs: number
  readonly #inFlight = new Map<string, Promise<string | null>>()

  constructor(opts: {
    cacheDir: string
    base?: string
    releasesApi?: string
    fetchFn?: typeof fetch
    now?: () => number
    maxAgeMs?: number
  }) {
    this.#dir = opts.cacheDir
    this.#base = opts.base ?? null
    this.#api = opts.releasesApi ?? MAC_APP_RELEASES_API
    this.#fetch = opts.fetchFn ?? fetch
    this.#now = opts.now ?? Date.now
    this.#maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60_000
  }

  /**
   * A local copy of `Hotsauce.dmg`, `.zip` or `mac-app.json`, fetched when missing or older than
   * six hours.
   */
  async file(asset: string): Promise<string | null> {
    const local = path.join(this.#dir, asset)
    // A download older than the version file we have may be the build before it: Settings would
    // offer an update and hand out the old app. Fetch it again.
    const info = path.join(this.#dir, MAC_APP_INFO)
    const behindInfo =
      asset !== MAC_APP_INFO &&
      existsSync(local) &&
      existsSync(info) &&
      statSync(info).mtimeMs > statSync(local).mtimeMs
    const fresh =
      !behindInfo && existsSync(local) && this.#now() - statSync(local).mtimeMs < this.#maxAgeMs
    if (fresh) return local
    let pending = this.#inFlight.get(asset)
    if (!pending) {
      pending = this.#download(asset, local).finally(() => this.#inFlight.delete(asset))
      this.#inFlight.set(asset, pending)
    }
    return pending
  }

  async #download(asset: string, local: string): Promise<string | null> {
    // A failed fetch keeps serving the copy we have, and waits the usual time before asking again.
    const fallback = existsSync(local) ? local : null
    const keep = () => {
      if (fallback) {
        const t = new Date(this.#now())
        utimesSync(fallback, t, t)
      }
      return fallback
    }
    const tmp = `${local}.part`
    try {
      const res = await this.#fetch(`${await this.#baseUrl()}/${asset}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(5 * 60_000),
      })
      if (!res.ok || !res.body) return keep()
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > MAX_BYTES) return keep()
      mkdirSync(this.#dir, { recursive: true })
      let seen = 0
      const limited = Readable.fromWeb(res.body as WebReadableStream).on(
        'data',
        (chunk: Buffer) => {
          seen += chunk.length
          if (seen > MAX_BYTES) limited.destroy(new Error('too large'))
        },
      )
      await pipeline(limited, createWriteStream(tmp))
      renameSync(tmp, local)
      return local
    } catch (err) {
      console.error(
        `Mac app download of ${asset} failed:`,
        err instanceof Error ? err.message : err,
      )
      rmSync(tmp, { force: true })
      return keep()
    }
  }

  /** Where the newest build is: looked up at most once per refresh period, so the app, its zip
   * and its version file come from the same release. A failed lookup keeps the last answer. */
  async #baseUrl(): Promise<string> {
    if (this.#base) return this.#base
    if (!this.#tag || this.#now() - this.#tag.at >= this.#maxAgeMs) {
      let name = this.#tag?.name ?? LEGACY_TAG
      try {
        const res = await this.#fetch(this.#api, {
          headers: { accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (res.ok) name = newestMacRelease(await res.json())
      } catch (err) {
        console.error('Mac app release lookup failed:', err instanceof Error ? err.message : err)
      }
      this.#tag = { name, at: this.#now() }
    }
    return `${MAC_APP_RELEASES}/${this.#tag.name}`
  }

}
