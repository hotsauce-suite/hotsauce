import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * The Mac app is built on a Mac, so the release image can't contain it. It is published on the
 * `mac-app` GitHub release (a prerelease, so the updater never takes it for a Hotsauce release),
 * and a server without a build of its own fetches it from there and keeps a copy on its disk.
 */
export const MAC_APP_RELEASE =
  'https://github.com/hotsauce-suite/hotsauce/releases/download/mac-app'

/** The names the app is offered under, including old ones in links already shared. */
export function releaseAsset(name: string): string | null {
  const m = /^(Hotsauce|Hearth|HearthDictate)\.(dmg|zip)$/.exec(name)
  return m ? `Hotsauce.${m[2]}` : null
}

const MAX_BYTES = 400 * 1024 * 1024

export class MacAppDownloads {
  readonly #dir: string
  readonly #base: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #maxAgeMs: number
  readonly #inFlight = new Map<string, Promise<string | null>>()

  constructor(opts: {
    cacheDir: string
    base?: string
    fetchFn?: typeof fetch
    now?: () => number
    maxAgeMs?: number
  }) {
    this.#dir = opts.cacheDir
    this.#base = opts.base ?? MAC_APP_RELEASE
    this.#fetch = opts.fetchFn ?? fetch
    this.#now = opts.now ?? Date.now
    this.#maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60_000
  }

  /** A local copy of `Hotsauce.dmg` or `.zip`, fetched when missing or older than six hours. */
  async file(asset: string): Promise<string | null> {
    const local = path.join(this.#dir, asset)
    const fresh = existsSync(local) && this.#now() - statSync(local).mtimeMs < this.#maxAgeMs
    if (fresh) return local
    let pending = this.#inFlight.get(asset)
    if (!pending) {
      pending = this.#download(asset, local).finally(() => this.#inFlight.delete(asset))
      this.#inFlight.set(asset, pending)
    }
    return pending
  }

  async #download(asset: string, local: string): Promise<string | null> {
    // A failed fetch keeps serving the copy we have.
    const fallback = existsSync(local) ? local : null
    const tmp = `${local}.part`
    try {
      const res = await this.#fetch(`${this.#base}/${asset}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(5 * 60_000),
      })
      if (!res.ok || !res.body) return fallback
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > MAX_BYTES) return fallback
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
      return fallback
    }
  }
}
