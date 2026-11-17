import { lookup } from 'node:dns/promises'
import type { ChatRooms, ReadTarget } from '../forms/index.js'
import { isPrivateHost } from '../forms/rooms.js'
import type { ChatMessage, ChatStore } from './store.js'

/**
 * Reads the chat rooms an admin switched on into the copy (docs/PLAN-chat-context.md R2–R6),
 * through each room's bot address: the whole history once, then what's new on every pass, plus
 * the threads of recent messages. The bot's key is in every address, so no address is ever logged
 * or stored.
 */

export interface ChatReaderOptions {
  rooms: Pick<ChatRooms, 'readTargets'>
  store: ChatStore
  fetch?: typeof fetch
  /** The addresses a hostname resolves to (checked every pass); tests pass a fake. */
  resolve?: (host: string) => Promise<string[]>
  /** How often a pass runs; 0 never starts a timer (tests call `pass()`). */
  intervalMs: number
  /** How many days back threads are re-read (hourly; the last day's on every pass). */
  threadDays: number
  /** Most pages one room reads in a pass. */
  maxPages?: number
  now?: () => Date
  log?: (message: string) => void
}

/** Most pages one room reads in a pass, so a huge history spreads over passes. */
export const MAX_PAGES_PER_PASS = 500
/** Most threads one room reads in a pass. */
export const MAX_THREADS_PER_PASS = 2000
const TIMEOUT_MS = 15_000
const FIRST_PASS_DELAY_MS = 5_000
const DAY_MS = 86_400_000
const WIDE_THREADS_EVERY_MS = 3_600_000

class ReadError extends Error {}

/** A message as the bot API writes it (Campfire's `messages/_message.json.jbuilder`). */
interface ApiMessage {
  id?: unknown
  created_at?: unknown
  body?: { plain_text?: unknown } | null
  attachment?: { filename?: unknown } | null
  creator?: { name?: unknown } | null
  url?: unknown
}

export class ChatReader {
  readonly #rooms: ChatReaderOptions['rooms']
  readonly #store: ChatStore
  readonly #fetch: typeof fetch
  readonly #resolve: (host: string) => Promise<string[]>
  readonly #intervalMs: number
  readonly #threadDays: number
  readonly #maxPages: number
  readonly #now: () => Date
  readonly #log: (m: string) => void
  /** When each room last re-read its older threads (in memory: a restart just reads them again). */
  readonly #wideThreadsAt = new Map<string, number>()
  #timer: NodeJS.Timeout | null = null
  #first: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null
  #again = false
  #closed = false

  constructor(opts: ChatReaderOptions) {
    this.#rooms = opts.rooms
    this.#store = opts.store
    this.#fetch = opts.fetch ?? fetch
    this.#resolve =
      opts.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
    this.#intervalMs = opts.intervalMs
    this.#threadDays = opts.threadDays
    this.#maxPages = Math.max(1, opts.maxPages ?? MAX_PAGES_PER_PASS)
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? console.warn
  }

  get store(): ChatStore {
    return this.#store
  }

  start(): void {
    if (this.#timer || this.#intervalMs <= 0) return
    this.#first = setTimeout(() => this.#background(), FIRST_PASS_DELAY_MS)
    this.#first.unref()
    this.#timer = setInterval(() => this.#background(), this.#intervalMs)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#first) clearTimeout(this.#first)
    this.#timer = null
    this.#first = null
    await this.#running?.catch(() => {})
  }

  /**
   * One pass over every room. A call while a pass runs is joined, and one more pass follows it,
   * so a room switched on mid-pass is read straight after.
   */
  pass(): Promise<void> {
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    const run = async () => {
      do {
        this.#again = false
        await this.#pass()
      } while (this.#again && !this.#closed)
    }
    this.#running = run().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  /** A pass nobody waits on: a failure is logged, never thrown. */
  #background(): void {
    this.pass().catch((err) => {
      this.#log(`chat: a read pass failed: ${err instanceof Error ? err.name : 'error'}`)
    })
  }

  async #pass(): Promise<void> {
    const targets = this.#rooms.readTargets()
    const wanted = new Set(targets.map((t) => t.id))
    // Reading turned off, or the room removed: its copy goes (R5).
    for (const room of this.#store.rooms()) if (!wanted.has(room)) this.#store.drop(room)
    for (const target of targets) {
      if (this.#closed) return
      try {
        await this.#checkHost(target)
        await this.#readRoom(target)
      } catch (err) {
        const why = err instanceof ReadError ? err.message : 'Couldn’t reach the chat.'
        this.#store.markFailed(target.id, why, this.#now().toISOString())
        this.#log(`chat: couldn't read room "${target.name}": ${why}`)
      }
    }
  }

  /** The chat's host must still be public: a name can be pointed somewhere else after it's added. */
  async #checkHost(target: ReadTarget): Promise<void> {
    const host = new URL(target.messagesUrl).hostname.replace(/^\[|\]$/g, '')
    const addresses = await this.#resolve(host).catch(() => [] as string[])
    if (addresses.length === 0) throw new ReadError('Couldn’t reach the chat.')
    if (isPrivateHost(host) || addresses.some(isPrivateHost)) {
      throw new ReadError('The chat’s address now points at a private network, so it isn’t read.')
    }
  }

  async #readRoom(target: ReadTarget): Promise<void> {
    const state = this.#store.state(target.id)
    let newest = state.newest
    let backfilled = state.backfilled
    let backfillBefore = state.backfillBefore
    let wholeHistory = false
    if (!backfilled) {
      // The whole history (R2): newest page first, then back until there's nothing before. A long
      // history carries on next pass from where this one stopped.
      let before: string | null
      let pages = 0
      if (backfillBefore) {
        before = backfillBefore
      } else {
        const first = await this.#page(target, {})
        this.#store.upsert(first.messages)
        newest = first.messages.at(-1)?.id ?? newest
        before = first.before
        pages = 1
      }
      while (before && pages < this.#maxPages && !this.#closed) {
        const page = await this.#page(target, { before }).catch((err) => {
          // The message we were going back from is gone: start the history again from the top.
          if (err instanceof NotFound) return null
          throw err
        })
        if (!page) {
          before = null
          backfillBefore = null
          this.#store.markRead(target.id, {
            newest,
            backfilled: false,
            backfillBefore: null,
            at: this.#now().toISOString(),
          })
          return
        }
        this.#store.upsert(page.messages)
        pages += 1
        // An empty page, or one that points back at itself, ends the history.
        before = page.messages.length > 0 && page.before !== before ? page.before : null
      }
      backfilled = before === null
      backfillBefore = before
      wholeHistory = backfilled
    } else {
      // What's new (R3): forward from the newest message copied.
      let after = newest
      let pages = 0
      while (after && pages < this.#maxPages && !this.#closed) {
        const page = await this.#page(target, { after }).catch((err) => {
          if (err instanceof NotFound) return null
          throw err
        })
        pages += 1
        if (!page) {
          // That message is gone from the chat: read back from the newest until we meet the copy.
          newest = await this.#catchUp(target, newest)
          break
        }
        this.#store.upsert(page.messages)
        const last = page.messages.at(-1)?.id ?? null
        if (last) newest = last
        if (!page.after || !last || page.after === after) break
        after = page.after
      }
      if (!after) newest = await this.#catchUp(target, newest)
    }
    // Saved before threads, so a thread that fails can't lose the messages read.
    this.#store.markRead(target.id, {
      newest,
      backfilled,
      backfillBefore,
      at: this.#now().toISOString(),
    })
    if (wholeHistory) {
      await this.#threads(target, this.#store.timeline(target.id))
      this.#wideThreadsAt.set(target.id, this.#now().getTime())
    } else if (backfilled) {
      const now = this.#now().getTime()
      const wide = now - (this.#wideThreadsAt.get(target.id) ?? 0) >= WIDE_THREADS_EVERY_MS
      const days = wide ? this.#threadDays : 1
      const since = new Date(now - days * DAY_MS).toISOString()
      await this.#threads(target, this.#store.recentTimeline(target.id, since))
      if (wide) this.#wideThreadsAt.set(target.id, now)
    }
  }

  /**
   * Reads back from the newest page until a page holds a message already copied, so nothing
   * written since `newest` is skipped. Returns the newest message now copied.
   */
  async #catchUp(target: ReadTarget, newest: string | null): Promise<string | null> {
    const known = (page: { messages: ChatMessage[] }) =>
      page.messages.some((m) => this.#store.has(target.id, m.id))
    let page = await this.#page(target, {})
    const top = page.messages.at(-1)?.id ?? newest
    let met = known(page)
    this.#store.upsert(page.messages)
    let pages = 1
    while (!met && page.before && pages < this.#maxPages && !this.#closed) {
      const before: string = page.before
      const next = await this.#page(target, { before }).catch((err) => {
        if (err instanceof NotFound) return null
        throw err
      })
      if (!next || next.messages.length === 0 || next.before === before) break
      met = known(next)
      this.#store.upsert(next.messages)
      page = next
      pages += 1
    }
    return top
  }

  /** Reads the threads of these timeline messages and copies their replies (R4). */
  async #threads(target: ReadTarget, ids: string[]): Promise<void> {
    for (const id of ids.slice(-MAX_THREADS_PER_PASS)) {
      if (this.#closed) return
      try {
        const res = await this.#get(target, `thread=${encodeURIComponent(id)}`, true)
        if (!res) continue
        const all = parseMessages(target.id, await res.json(), null, keyOf(target.messagesUrl))
        // The thread's own message comes first; the rest are its replies.
        const replies = all.filter((m) => m.id !== id).map((m) => ({ ...m, thread: id }))
        if (replies.length > 0) this.#store.upsert(replies)
      } catch (err) {
        // One thread that can't be read is skipped; the next pass tries it again.
        if (err instanceof ReadError && /refused/.test(err.message)) throw err
      }
    }
  }

  async #page(
    target: ReadTarget,
    cursor: { before?: string; after?: string },
  ): Promise<{ messages: ChatMessage[]; before: string | null; after: string | null }> {
    const query = cursor.after
      ? `after=${encodeURIComponent(cursor.after)}`
      : cursor.before
        ? `before=${encodeURIComponent(cursor.before)}`
        : ''
    const res = await this.#get(target, query, false)
    if (!res) throw new NotFound()
    const messages = parseMessages(target.id, await res.json(), null, keyOf(target.messagesUrl))
    // Only the cursor is taken from the Link header, never its address.
    const next = nextCursor(res.headers.get('link'))
    return {
      messages,
      before: next?.kind === 'before' ? next.id : null,
      after: next?.kind === 'after' ? next.id : null,
    }
  }

  /** GETs the room's messages with `query`; null on a 404 when `missingOk` or a cursor was sent. */
  async #get(target: ReadTarget, query: string, missingOk: boolean): Promise<Response | null> {
    const url = query ? `${target.messagesUrl}?${query}` : target.messagesUrl
    let res: Response
    try {
      res = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new ReadError('Couldn’t reach the chat.')
    }
    if (res.status === 404 && (missingOk || query !== '')) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) {
      await res.body?.cancel()
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new ReadError(
          'The chat refused the bot. It may have been removed from the room, or its key changed: copy the room’s link again.',
        )
      }
      throw new ReadError(`The chat answered ${res.status}.`)
    }
    return res
  }
}

class NotFound extends Error {}

/** The bot key in a room's read address, `/rooms/<room>/<key>/messages`. */
const keyOf = (messagesUrl: string) =>
  /\/rooms\/[^/]+\/([^/]+)\/messages$/.exec(messagesUrl)?.[1] ?? ''

/** The cursor in a `Link: <…?before=ID>; rel="next"` header. */
export function nextCursor(link: string | null): { kind: 'before' | 'after'; id: string } | null {
  if (!link) return null
  for (const part of link.split(',')) {
    if (!/rel="?next"?/.test(part)) continue
    const m = /[?&](before|after)=([^&>]+)/.exec(part)
    if (m) return { kind: m[1] as 'before' | 'after', id: decodeURIComponent(m[2]!) }
  }
  return null
}

const MAX_TEXT = 20_000

/** The bot API's messages as the copy keeps them; anything malformed is skipped. */
export function parseMessages(
  room: string,
  json: unknown,
  thread: string | null,
  /** The bot's key: a link that carries it is never kept (R12). */
  secret = '',
): ChatMessage[] {
  if (!Array.isArray(json)) throw new ReadError('The chat answered something that isn’t messages.')
  const out: ChatMessage[] = []
  for (const raw of json as ApiMessage[]) {
    if (!raw || typeof raw !== 'object') continue
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id)
    const createdAt = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : Number.NaN
    if (!id || Number.isNaN(createdAt)) continue
    const plain = typeof raw.body?.plain_text === 'string' ? raw.body.plain_text.trim() : ''
    const file = typeof raw.attachment?.filename === 'string' ? raw.attachment.filename : ''
    const text = (plain || (file ? `[file: ${file}]` : '')).slice(0, MAX_TEXT)
    if (!text) continue
    const link = typeof raw.url === 'string' && /^https:\/\//.test(raw.url) ? raw.url : ''
    const url = secret && link.includes(secret) ? '' : link
    out.push({
      room,
      id,
      thread,
      createdAt: new Date(createdAt).toISOString(),
      author: typeof raw.creator?.name === 'string' ? raw.creator.name.slice(0, 200) : 'Someone',
      text,
      url,
    })
  }
  return out
}
