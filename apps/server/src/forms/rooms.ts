import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
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
  readonly #resolve: (host: string) => Promise<string[]>

  constructor(opts: {
    dataDir: string
    fetch?: typeof fetch
    log?: (m: string) => void
    /** The addresses a hostname resolves to; tests pass a fake. */
    resolve?: (host: string) => Promise<string[]>
  }) {
    this.#resolve =
      opts.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
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

  /**
   * Adds a room after posting "connected" to it, so a wrong link is refused with the reason
   * rather than saved and silently dropping every answer. Slack and Slack-compatible chat
   * addresses answer a good post with `ok`.
   */
  async add(name: string, url: string): Promise<ChatRoom> {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!clean) throw new HearthError('bad_request', 'Give the room a name')
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      throw new HearthError('bad_request', 'That isn’t a web address')
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new HearthError('bad_request', 'The webhook link must start with https://')
    }
    // Only public chat services: never this server or anything on its private network.
    const host = parsed.hostname.replace(/\.+$/, '')
    const addresses = await this.#resolve(host.replace(/^\[|\]$/g, '')).catch(() => [] as string[])
    if (addresses.length === 0)
      throw new HearthError('bad_request', 'Couldn’t find that link’s server')
    if (isPrivateHost(host) || addresses.some(isPrivateHost)) {
      throw new HearthError('bad_request', 'That link points at a private address')
    }
    // Some chat apps' bots pages also offer a plain "message command" address, which takes text,
    // not a Slack message. Their Slack-compatible one ends in /slack.
    if (/\/rooms\/[^/]+\/[^/]+\/messages\/?$/.test(parsed.pathname)) {
      throw new HearthError(
        'bad_request',
        'That’s the bot’s message address. Use “Copy Slack-compatible webhook URL” instead (it ends in /slack).',
      )
    }
    const rooms = this.#read()
    if (rooms.length >= MAX_ROOMS) {
      throw new HearthError('bad_request', `At most ${MAX_ROOMS} rooms`)
    }
    let answer = ''
    let status = 0
    try {
      const res = await this.#fetch(parsed.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Hearth Forms is connected. New form answers will be posted here.`,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      })
      status = res.status
      answer = (await res.text()).slice(0, 200).trim()
    } catch {
      throw new HearthError('bad_request', 'Couldn’t reach that link. Check it and try again.')
    }
    if (status < 200 || status >= 300 || answer.toLowerCase() !== 'ok') {
      throw new HearthError(
        'bad_request',
        `That link didn’t take a test message (it answered ${status}). Copy the bot’s Slack-compatible webhook URL and try again.`,
      )
    }
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
        redirect: 'manual',
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

/** A hostname that names this machine or a private network: localhost, or a private IP literal. */
export function isPrivateHost(host: string): boolean {
  const h = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return true
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (h.includes(':'))
    return (
      h === '::1' ||
      h === '::' ||
      /^f[cd]/.test(h) ||
      /^fe[89ab]/.test(h) ||
      h.startsWith('::ffff:')
    )
  return false
}
