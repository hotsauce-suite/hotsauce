import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { KeyedMutex } from '../git/mutex.js'

const Member = z.object({
  email: z.string(),
  /** The member's IANA time zone, as their browser last said; UTC until it does. */
  tz: z.string().default('UTC'),
  /** When the nightly pass last looked at this member (ISO), whether or not it wrote. */
  checkedAt: z.string().nullable().default(null),
})
export type BriefMember = z.infer<typeof Member>

const State = z.object({ members: z.record(z.string(), Member).default({}) })
type State = z.infer<typeof State>

/**
 * Who gets a nightly brief, and when each was last looked at. Scheduling state, not member data:
 * it lives on the volume (`DATA_DIR/brief/members.json`), never in Git. Losing it only means a
 * member's brief waits until they next open it or use Meetings. Keyed by user id, so the nightly
 * pass can re-check the member with `Authenticator.principalForUser`.
 */
export class BriefMembers {
  readonly #file: string
  readonly #lock = new KeyedMutex()
  #state: State | null = null

  /** `folder` lets Briefcast keep its own schedule beside the brief's (`DATA_DIR/briefcast/`). */
  constructor(dataDir: string, folder = 'brief') {
    this.#file = path.join(dataDir, folder, 'members.json')
  }

  async list(): Promise<Array<BriefMember & { userId: string }>> {
    const { members } = await this.#load()
    return Object.entries(members).map(([userId, m]) => ({ userId, ...m }))
  }

  async get(userId: string): Promise<BriefMember | null> {
    return (await this.#load()).members[userId] ?? null
  }

  /** Records the member (and their zone, when known) so the nightly pass includes them. */
  async touch(userId: string, email: string, tz?: string): Promise<void> {
    const current = (await this.#load()).members[userId]
    if (current && current.email === email && (tz === undefined || current.tz === tz)) return
    await this.#update((s) => {
      const was = s.members[userId]
      s.members[userId] = {
        email,
        tz: tz ?? was?.tz ?? 'UTC',
        checkedAt: was?.checkedAt ?? null,
      }
    })
  }

  async markChecked(userId: string, at: Date): Promise<void> {
    await this.#update((s) => {
      const m = s.members[userId]
      if (m) m.checkedAt = at.toISOString()
    })
  }

  async remove(userId: string): Promise<void> {
    await this.#update((s) => {
      delete s.members[userId]
    })
  }

  async #load(): Promise<State> {
    if (this.#state) return this.#state
    try {
      this.#state = State.parse(JSON.parse(await readFile(this.#file, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`brief: ${this.#file} is unreadable, starting empty: ${err}`)
      }
      this.#state = { members: {} }
    }
    return this.#state
  }

  #update(change: (s: State) => void): Promise<void> {
    return this.#lock.run('state', async () => {
      const state = await this.#load()
      change(state)
      await mkdir(path.dirname(this.#file), { recursive: true })
      await writeFile(`${this.#file}.tmp`, JSON.stringify(state))
      await rename(`${this.#file}.tmp`, this.#file)
    })
  }
}
