import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SNIPPET_CLOSE, SNIPPET_OPEN, toFtsAnyQuery, toFtsQuery } from '../index/index.js'

/**
 * The copy of the chat rooms an admin lets Hotsauce read (docs/PLAN-chat-context.md). Its own
 * SQLite file on the volume; a cache of the chat, which stays the truth: deleting the file only
 * makes the next pass read every room again.
 */

export interface ChatMessage {
  /** Hotsauce's id for the room (the chat rooms list's), never the chat's own address. */
  room: string
  id: string
  /** The message a thread reply answers, or null for one in the room's timeline. */
  thread: string | null
  createdAt: string
  author: string
  text: string
  /** The message's own link in the chat. */
  url: string
}

export interface ChatHit extends ChatMessage {
  /** The text around the match; matched terms are wrapped in SNIPPET_OPEN / SNIPPET_CLOSE. */
  snippet: string
  score: number
}

export interface ChatRoomState {
  room: string
  /** The newest timeline message copied, which the next pass reads after. */
  newest: string | null
  /** True once the room's whole history has been copied. */
  backfilled: boolean
  readAt: string | null
  error: string | null
  messages: number
}

const MIGRATIONS = [
  `
  CREATE TABLE messages (
    rowid      INTEGER PRIMARY KEY,
    room       TEXT NOT NULL,
    id         TEXT NOT NULL,
    thread     TEXT,
    created_at TEXT NOT NULL,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    url        TEXT NOT NULL,
    UNIQUE (room, id)
  );
  CREATE INDEX messages_time ON messages (room, created_at);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    author, text,
    content = 'messages', content_rowid = 'rowid',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, author, text) VALUES (new.rowid, new.author, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, author, text)
      VALUES ('delete', old.rowid, old.author, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, author, text)
      VALUES ('delete', old.rowid, old.author, old.text);
    INSERT INTO messages_fts (rowid, author, text) VALUES (new.rowid, new.author, new.text);
  END;

  CREATE TABLE rooms (
    room       TEXT PRIMARY KEY,
    newest     TEXT,
    backfilled INTEGER NOT NULL DEFAULT 0,
    read_at    TEXT,
    error      TEXT
  );
  `,
]

interface MessageRow {
  room: string
  id: string
  thread: string | null
  created_at: string
  author: string
  text: string
  url: string
}

const toMessage = (r: MessageRow): ChatMessage => ({
  room: r.room,
  id: r.id,
  thread: r.thread,
  createdAt: r.created_at,
  author: r.author,
  text: r.text,
  url: r.url,
})

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export class ChatStore {
  readonly #db: Database.Database

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = NORMAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#migrate()
  }

  close(): void {
    this.#db.close()
  }

  #migrate(): void {
    this.#db
      .transaction(() => {
        this.#db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
        const row = this.#db.prepare('SELECT version FROM schema_version').get() as
          | { version: number }
          | undefined
        const current = row?.version ?? 0
        if (!row) this.#db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
        // A newer release's copy: it's a cache, so start it over rather than guess.
        if (current > MIGRATIONS.length) {
          for (const t of ['messages_fts', 'messages', 'rooms'])
            this.#db.exec(`DROP TABLE IF EXISTS ${t}`)
          for (const sql of MIGRATIONS) this.#db.exec(sql)
        } else {
          for (const sql of MIGRATIONS.slice(current)) this.#db.exec(sql)
        }
        this.#db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length)
      })
      .immediate()
  }

  /** Adds messages, replacing any already copied (an edit read again). */
  upsert(messages: ChatMessage[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO messages (room, id, thread, created_at, author, text, url)
       VALUES (@room, @id, @thread, @createdAt, @author, @text, @url)
       ON CONFLICT (room, id) DO UPDATE SET
         thread = excluded.thread, created_at = excluded.created_at, author = excluded.author,
         text = excluded.text, url = excluded.url
       WHERE messages.text <> excluded.text OR messages.author <> excluded.author
         OR messages.url <> excluded.url OR coalesce(messages.thread, '') <> coalesce(excluded.thread, '')`,
    )
    this.#db.transaction(() => {
      for (const m of messages) stmt.run(m)
    })()
  }

  state(room: string): ChatRoomState {
    const row = this.#db
      .prepare<
        [string],
        { newest: string | null; backfilled: number; read_at: string | null; error: string | null }
      >('SELECT newest, backfilled, read_at, error FROM rooms WHERE room = ?')
      .get(room)
    return {
      room,
      newest: row?.newest ?? null,
      backfilled: row?.backfilled === 1,
      readAt: row?.read_at ?? null,
      error: row?.error ?? null,
      messages: this.count(room),
    }
  }

  count(room: string): number {
    return (
      this.#db
        .prepare<[string], { n: number }>('SELECT count(*) AS n FROM messages WHERE room = ?')
        .get(room)?.n ?? 0
    )
  }

  /** Records a successful read: where the room's timeline was read up to, and when. */
  markRead(room: string, update: { newest: string | null; backfilled: boolean; at: string }): void {
    this.#db
      .prepare(
        `INSERT INTO rooms (room, newest, backfilled, read_at, error) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (room) DO UPDATE SET newest = excluded.newest, backfilled = excluded.backfilled,
           read_at = excluded.read_at, error = NULL`,
      )
      .run(room, update.newest, update.backfilled ? 1 : 0, update.at)
  }

  /** Records why a read failed, keeping what was copied and where it got to. */
  markFailed(room: string, error: string, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO rooms (room, read_at, error) VALUES (?, ?, ?)
         ON CONFLICT (room) DO UPDATE SET read_at = excluded.read_at, error = excluded.error`,
      )
      .run(room, at, error)
  }

  /** The rooms with anything copied or recorded. */
  rooms(): string[] {
    return this.#db
      .prepare<[], { room: string }>(
        'SELECT room FROM rooms UNION SELECT DISTINCT room FROM messages',
      )
      .all()
      .map((r) => r.room)
  }

  /** Forgets a room: its messages and where reading had got to. */
  drop(room: string): void {
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM messages WHERE room = ?').run(room)
      this.#db.prepare('DELETE FROM rooms WHERE room = ?').run(room)
    })()
  }

  /** Timeline messages written since `since`, oldest first, whose threads are read again. */
  recentTimeline(room: string, since: string): string[] {
    return this.#db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM messages WHERE room = ? AND thread IS NULL AND created_at >= ? ORDER BY created_at',
      )
      .all(room, since)
      .map((r) => r.id)
  }

  /** Every timeline message, oldest first (the threads read once a room is first copied). */
  timeline(room: string): string[] {
    return this.recentTimeline(room, '')
  }

  /**
   * Messages matching `q` in `rooms`, best first. Words are ANDed as prefixes; with `anyTerm`,
   * any of them matches (for an AI's questions).
   */
  search(
    q: string,
    opts: { rooms: string[]; limit?: number; anyTerm?: boolean; since?: string },
  ): ChatHit[] {
    if (opts.rooms.length === 0) return []
    const fts = opts.anyTerm ? toFtsAnyQuery(q) : toFtsQuery(q)
    if (!fts) return []
    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT))
    const rooms = opts.rooms.map(() => '?').join(', ')
    const rows = this.#db
      .prepare(
        `SELECT m.room, m.id, m.thread, m.created_at, m.author, m.text, m.url,
           snippet(messages_fts, 1, ?, ?, '…', 24) AS snippet,
           -bm25(messages_fts, 2, 1) AS score
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.room IN (${rooms}) AND m.created_at >= ?
         ORDER BY score DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(SNIPPET_OPEN, SNIPPET_CLOSE, fts, ...opts.rooms, opts.since ?? '', limit) as Array<
      MessageRow & { snippet: string; score: number }
    >
    return rows.map((r) => ({ ...toMessage(r), snippet: r.snippet, score: r.score }))
  }

  /**
   * A room's messages, oldest first: the `limit` newest written before `before` (or ever), or the
   * `limit` oldest written from `after` on. Thread replies are included, each after the time it
   * was written.
   */
  messages(
    room: string,
    opts: { before?: string; after?: string; limit?: number } = {},
  ): ChatMessage[] {
    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? 50))
    if (opts.after !== undefined) {
      return (
        this.#db
          .prepare(
            'SELECT * FROM messages WHERE room = ? AND created_at >= ? ORDER BY created_at, id LIMIT ?',
          )
          .all(room, opts.after, limit) as MessageRow[]
      ).map(toMessage)
    }
    const rows = this.#db
      .prepare(
        'SELECT * FROM messages WHERE room = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(room, opts.before ?? '￿', limit) as MessageRow[]
    return rows.reverse().map(toMessage)
  }

  /** Messages in `rooms` written since `since`, oldest first, up to `limit`. */
  since(rooms: string[], since: string, limit = 2000): ChatMessage[] {
    if (rooms.length === 0) return []
    const marks = rooms.map(() => '?').join(', ')
    return (
      this.#db
        .prepare(
          `SELECT * FROM (SELECT * FROM messages WHERE room IN (${marks}) AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?) ORDER BY created_at, id`,
        )
        .all(...rooms, since, limit) as MessageRow[]
    ).map(toMessage)
  }
}
