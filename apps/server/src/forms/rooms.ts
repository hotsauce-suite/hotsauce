import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { HearthError } from '../errors.js'

/**
 * Chat rooms that Hearth Forms posts new answers to (ARCHITECTURE §21.5). Each room is a
 * Slack-compatible incoming webhook: a chat app such as Slack gives every bot one per room, and Slack
 * itself works too. The webhook URL is a credential, so it lives on the volume, never in Git or an
 * API response; members see a room's name, admins also its last four characters.
 */

export const MAX_ROOMS = 20

const Room = z.object({ id: z.string(), name: z.string(), url: z.string() })
const RoomsFile = z.object({ rooms: z.array(Room).default([]) })

export interface ChatRoom {
  id: string
  name: string
  /** The webhook's last four characters, so an admin can tell two apart. */
  last4: string
}

export class ChatRooms {
  readonly #file: string
  readonly #fetch: typeof fetch
  readonly #log: (message: string) => void

  constructor(opts: { dataDir: string; fetch?: typeof fetch; log?: (m: string) => void }) {
    this.#file = path.join(opts.dataDir, 'forms', 'rooms.json')
    this.#fetch = opts.fetch ?? fetch
    this.#log = opts.log ?? console.warn
  }

  list(): ChatRoom[] {
    return this.#read().map((r) => ({ id: r.id, name: r.name, last4: r.url.slice(-4) }))
  }

  has(id: string): boolean {
    return this.#read().some((r) => r.id === id)
  }

  add(name: string, url: string): ChatRoom {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!clean) throw new HearthError('bad_request', 'A room needs a name')
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      throw new HearthError('bad_request', 'That isn’t a web address')
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new HearthError('bad_request', 'The webhook link must start with https://')
    }
    const rooms = this.#read()
    if (rooms.length >= MAX_ROOMS)
      throw new HearthError('bad_request', `At most ${MAX_ROOMS} rooms`)
    const room = { id: randomBytes(6).toString('base64url'), name: clean, url: parsed.toString() }
    this.#write([...rooms, room])
    return { id: room.id, name: room.name, last4: room.url.slice(-4) }
  }

  remove(id: string): void {
    const rooms = this.#read()
    if (!rooms.some((r) => r.id === id)) throw new HearthError('not_found', 'No such room')
    this.#write(rooms.filter((r) => r.id !== id))
  }

  /** Posts Slack-formatted text; false (and a log line) when the room is gone or the post fails. */
  async post(id: string, text: string): Promise<boolean> {
    let room: z.infer<typeof Room> | undefined
    try {
      room = this.#read().find((r) => r.id === id)
    } catch (err) {
      this.#log(`forms: chat rooms file can't be read: ${err}`)
      return false
    }
    if (!room) return false
    try {
      const res = await this.#fetch(room.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      })
      await res.body?.cancel()
      if (!res.ok) this.#log(`forms: chat room "${room.name}" answered ${res.status}`)
      return res.ok
    } catch (err) {
      this.#log(`forms: couldn't post to chat room "${room.name}": ${err}`)
      return false
    }
  }

  #read(): z.infer<typeof Room>[] {
    if (!existsSync(this.#file)) return []
    return RoomsFile.parse(JSON.parse(readFileSync(this.#file, 'utf8'))).rooms
  }

  #write(rooms: z.infer<typeof Room>[]): void {
    mkdirSync(path.dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ rooms }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.#file)
  }
}
