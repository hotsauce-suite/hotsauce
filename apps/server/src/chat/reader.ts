import type { ChatRooms, ReadTarget } from '../forms/index.js'
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
  /** How often a pass runs; 0 never starts a timer (tests call `pass()`). */
  intervalMs: number
  /** How many days back each pass re-reads threads. */
  threadDays: number
  now?: () => Date
  log?: (message: string) => void
}

/** Most pages one room reads in a pass, so a huge history spreads over passes. */
export const MAX_PAGES_PER_PASS = 500
/** Most threads one room reads in a pass. */
export const MAX_THREADS_PER_PASS = 2000
const TIMEOUT_MS = 15_000
const FIRST_PASS_DELAY_MS = 5_000

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
  readonly #intervalMs: number
  readonly #threadDays: number
  readonly #now: () => Date
  readonly #log: (m: string) => void
  #timer: NodeJS.Timeout | null = null
  #first: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null
  #closed = false

  constructor(opts: ChatReaderOptions) {
    this.#rooms = opts.rooms
    this.#store = opts.store
    this.#fetch = opts.fetch ?? fetch
    this.#intervalMs = opts.intervalMs
    this.#threadDays = opts.threadDays
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? console.warn
  }

  get store(): ChatStore {
    return this.#store
  }

  start(): void {
    if (this.#timer || this.#intervalMs <= 0) return
    this.#first = setTimeout(() => void this.pass(), FIRST_PASS_DELAY_MS)
    this.#first.unref()
    this.#timer = setInterval(() => void this.pass(), this.#intervalMs)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#first) clearTimeout(this.#first)
    this.#timer = null
    this.#first = null
    await this.#running
  }

  /** One pass over every room; a pass still running is joined rather than doubled. */
  pass(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #pass(): Promise<void> {
    const targets = this.#rooms.readTargets()
    const wanted = new Set(targets.map((t) => t.id))
    // Reading turned off, or the room removed: its copy goes (R5).
    for (const room of this.#store.rooms()) if (!wanted.has(room)) this.#store.drop(room)
    for (const target of targets) {
      if (this.#closed) return
      try {
        await this.#readRoom(target)
      } catch (err) {
        const why = err instanceof ReadError ? err.message : 'Couldn’t reach the chat.'
        this.#store.markFailed(target.id, why, this.#now().toISOString())
        this.#log(`chat: couldn't read room "${target.name}": ${why}`)
      }
    }
  }

  async #readRoom(target: ReadTarget): Promise<void> {
    const state = this.#store.state(target.id)
    let newest = state.newest
    let backfilled = state.backfilled
    if (!backfilled) {
      // The whole history (R2): newest page first, then back until there's nothing before.
      const first = await this.#page(target, {})
      this.#store.upsert(first.messages)
      newest = first.messages.at(-1)?.id ?? null
      let before = first.before
      let pages = 1
      while (before && pages < MAX_PAGES_PER_PASS && !this.#closed) {
        const page = await this.#page(target, { before })
        this.#store.upsert(page.messages)
        before = page.before
        pages += 1
      }
      // A history longer than one pass carries on next time from scratch; the copy dedupes.
      backfilled = before === null
      if (backfilled) await this.#threads(target, this.#store.timeline(target.id))
    } else {
      // What's new (R3): forward from the newest message copied.
      let after = newest
      let pages = 0
      while (pages < MAX_PAGES_PER_PASS && !this.#closed) {
        const page = after
          ? await this.#page(target, { after }).catch((err) => {
              // That message is gone from the chat: start again from the newest page.
              if (err instanceof NotFound) return null
              throw err
            })
          : null
        const read = page ?? (await this.#page(target, {}))
        this.#store.upsert(read.messages)
        if (read.messages.length > 0) newest = read.messages.at(-1)!.id
        pages += 1
        if (!page || !read.after) break
        after = newest
      }
      const since = new Date(this.#now().getTime() - this.#threadDays * 86_400_000)
      await this.#threads(target, this.#store.recentTimeline(target.id, since.toISOString()))
    }
    this.#store.markRead(target.id, { newest, backfilled, at: this.#now().toISOString() })
  }

  /** Reads the threads of these timeline messages and copies their replies (R4). */
  async #threads(target: ReadTarget, ids: string[]): Promise<void> {
    for (const id of ids.slice(-MAX_THREADS_PER_PASS)) {
      if (this.#closed) return
      const res = await this.#get(target, `thread=${encodeURIComponent(id)}`, true)
      if (!res) continue
      const all = parseMessages(target.id, await res.json(), null, keyOf(target.messagesUrl))
      // The thread's own message comes first; the rest are its replies.
      const replies = all.filter((m) => m.id !== id).map((m) => ({ ...m, thread: id }))
      if (replies.length > 0) this.#store.upsert(replies)
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
