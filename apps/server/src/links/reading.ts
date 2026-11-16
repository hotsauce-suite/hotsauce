import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** Where a member is in one saved link (docs/PLAN-links-reading-position.md). */
export interface ReadingPlace {
  /** The block of the readable copy at the top of their screen, from 0. */
  anchor: number
  /** How far through the copy the bottom of their screen is, 0 to 100. */
  percent: number
  /** The most of the copy they have ever reached, 0 to 100; it never goes down. */
  furthest: number
  updated: string
}

/** The highest block index kept: far past any copy (200,000 characters). */
export const MAX_ANCHOR = 100_000

const MIGRATIONS = [
  `
  CREATE TABLE reading (
    user_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    anchor INTEGER NOT NULL,
    percent REAL NOT NULL,
    furthest REAL NOT NULL,
    updated TEXT NOT NULL,
    PRIMARY KEY (user_id, link_id)
  );
  CREATE INDEX reading_link ON reading (link_id);
  `,
]

interface Row {
  link_id: string
  anchor: number
  percent: number
  furthest: number
  updated: string
}

const clampPercent = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0)
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Members' places in saved links. Its own SQLite file on the volume, beside the index rather than
 * in it (the index is rebuilt from Git) and not in Git: a place changes every few seconds of
 * reading and belongs to one member, even on a team link. Keyed by link id, so a link keeps its
 * places when it moves between spaces.
 */
export class ReadingStore {
  readonly #db: Database.Database

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
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
        for (const sql of MIGRATIONS.slice(current)) this.#db.exec(sql)
        this.#db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length)
      })
      .immediate()
  }

  /** Saves a member's place; `furthest` keeps the most they ever reached. */
  set(
    userId: string,
    linkId: string,
    place: { anchor: number; percent: number },
    now = new Date(),
  ): ReadingPlace {
    const anchor = Math.min(MAX_ANCHOR, Math.max(0, Math.trunc(place.anchor) || 0))
    const percent = round1(clampPercent(place.percent))
    const updated = now.toISOString()
    this.#db
      .prepare(
        `INSERT INTO reading (user_id, link_id, anchor, percent, furthest, updated)
         VALUES (@userId, @linkId, @anchor, @percent, @percent, @updated)
         ON CONFLICT (user_id, link_id) DO UPDATE SET
           anchor = excluded.anchor,
           percent = excluded.percent,
           furthest = MAX(reading.furthest, excluded.percent),
           updated = excluded.updated`,
      )
      .run({ userId, linkId, anchor, percent, updated })
    return this.get(userId, linkId) as ReadingPlace
  }

  get(userId: string, linkId: string): ReadingPlace | null {
    const row = this.#db
      .prepare(
        'SELECT link_id, anchor, percent, furthest, updated FROM reading WHERE user_id = ? AND link_id = ?',
      )
      .get(userId, linkId) as Row | undefined
    return row ? toPlace(row) : null
  }

  /** Every place a member has, by link id. */
  allFor(userId: string): Map<string, ReadingPlace> {
    const rows = this.#db
      .prepare('SELECT link_id, anchor, percent, furthest, updated FROM reading WHERE user_id = ?')
      .all(userId) as Row[]
    return new Map(rows.map((r) => [r.link_id, toPlace(r)]))
  }

  /** Forgets every member's place in a link (it was deleted). */
  forget(linkId: string): void {
    this.#db.prepare('DELETE FROM reading WHERE link_id = ?').run(linkId)
  }
}

function toPlace(r: Row): ReadingPlace {
  return { anchor: r.anchor, percent: r.percent, furthest: r.furthest, updated: r.updated }
}
