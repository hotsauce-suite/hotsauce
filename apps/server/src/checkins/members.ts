import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { KeyedMutex } from '../git/mutex.js'

const Member = z.object({ name: z.string(), tz: z.string() })
const State = z.object({ members: z.record(z.string(), Member).default({}) })
type State = z.infer<typeof State>
export type CheckinMember = z.infer<typeof Member>

/**
 * Each member's name and time zone as their browser last said, keyed by email, so a round opens
 * at their own 9 AM (ARCHITECTURE §24.2). Scheduling state on the volume
 * (`DATA_DIR/checkins/members.json`), never in Git; losing it only means the check-in's own zone
 * is used until they next open Today or Check-ins.
 */
export class CheckinMembers {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  #state: State | null = null

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'checkins', 'members.json')
  }

  async get(email: string): Promise<CheckinMember | null> {
    return (await this.#load()).members[email.toLowerCase()] ?? null
  }

  async all(): Promise<Record<string, CheckinMember>> {
    return { ...(await this.#load()).members }
  }

  async touch(email: string, name: string, tz: string | undefined): Promise<void> {
    const key = email.toLowerCase()
    const was = (await this.#load()).members[key]
    const next = { name, tz: tz ?? was?.tz ?? '' }
    if (was && was.name === next.name && was.tz === next.tz) return
    await this.#lock.run('state', async () => {
      const state = await this.#load()
      state.members[key] = next
      await mkdir(path.dirname(this.#file), { recursive: true })
      await writeFile(`${this.#file}.tmp`, JSON.stringify(state))
      await rename(`${this.#file}.tmp`, this.#file)
    })
  }

  async #load(): Promise<State> {
    if (this.#state) return this.#state
    try {
      this.#state = State.parse(JSON.parse(await readFile(this.#file, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`checkins: ${this.#file} is unreadable, starting empty: ${err}`)
      }
      this.#state = { members: {} }
    }
    return this.#state
  }
}
