import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { KeyedMutex } from '../git/mutex.js'

const State = z.object({
  /** userId → the member's private podcast feed token. */
  feeds: z.record(z.string(), z.object({ token: z.string(), email: z.string() })).default({}),
  /** Audio object key → who and which day, so audio older than 30 days can be deleted. */
  audio: z.record(z.string(), z.object({ userId: z.string(), date: z.string() })).default({}),
})
type State = z.infer<typeof State>

/**
 * Briefcast's volume state (`DATA_DIR/briefcast/state.json`): feed tokens and which audio objects
 * exist. Not member data: losing it only means feed URLs must be made again and old audio waits
 * for a manual clean-up. The scripts themselves are in Git.
 */
export class BriefcastState {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  #state: State | null = null

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'briefcast', 'state.json')
  }

  async feedToken(userId: string): Promise<string | null> {
    return (await this.#load()).feeds[userId]?.token ?? null
  }

  /** A new feed token for the member; the old one stops working. */
  async rotateFeed(userId: string, email: string): Promise<string> {
    const token = randomBytes(24).toString('base64url')
    await this.#update((s) => {
      s.feeds[userId] = { token, email }
    })
    return token
  }

  async removeFeed(userId: string): Promise<void> {
    await this.#update((s) => {
      delete s.feeds[userId]
    })
  }

  /** The member a feed token belongs to, compared in constant time. */
  async userForToken(token: string): Promise<string | null> {
    const given = Buffer.from(token)
    for (const [userId, feed] of Object.entries((await this.#load()).feeds)) {
      const want = Buffer.from(feed.token)
      if (want.length === given.length && timingSafeEqual(want, given)) return userId
    }
    return null
  }

  async recordAudio(key: string, userId: string, date: string): Promise<void> {
    await this.#update((s) => {
      s.audio[key] = { userId, date }
    })
  }

  /** Audio keys dated before `date` (ISO day). */
  async audioBefore(date: string): Promise<string[]> {
    return Object.entries((await this.#load()).audio)
      .filter(([, a]) => a.date < date)
      .map(([key]) => key)
  }

  async forgetAudio(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.#update((s) => {
      for (const key of keys) delete s.audio[key]
    })
  }

  async #load(): Promise<State> {
    if (this.#state) return this.#state
    try {
      this.#state = State.parse(JSON.parse(await readFile(this.#file, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.#state = State.parse({})
    }
    return this.#state
  }

  async #update(change: (s: State) => void): Promise<void> {
    await this.#lock.run('state', async () => {
      const state = await this.#load()
      change(state)
      await mkdir(path.dirname(this.#file), { recursive: true })
      const tmp = `${this.#file}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2))
      await rename(tmp, this.#file)
    })
  }
}
