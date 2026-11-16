import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** What `index.sqlite` held for members before this store existed (docs/PLAN-member-lists.md R4). */
export interface LegacyMemberLists {
  recents: Array<{ user: string; space: string; path: string; openedAt: string }>
  stars: Array<{ user: string; space: string; path: string }>
  /** `apps` is the JSON array of app ids, as stored. */
  pins: Array<{ user: string; apps: string }>
}

const MIGRATIONS = [
  `
  CREATE TABLE recents (
    user      TEXT NOT NULL,
    space     TEXT NOT NULL,
    path      TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (user, space, path)
  );
  CREATE INDEX recents_by_time ON recents (user, opened_at);

  CREATE TABLE stars (
    user  TEXT NOT NULL,
    space TEXT NOT NULL,
    path  TEXT NOT NULL,
    PRIMARY KEY (user, space, path)
  );

  -- The apps each member pinned to their rail, in order, as a JSON array of app ids. No row: the
  -- member never changed them, and the app shows the default pins.
  CREATE TABLE pins (
    user TEXT PRIMARY KEY,
    apps TEXT NOT NULL
  );

  -- One-time steps already done to this file, by name (the copy out of the index).
  CREATE TABLE done (
    name TEXT PRIMARY KEY,
    at   TEXT NOT NULL
  );
  `,
]

const FROM_INDEX = 'copied-from-index'

/**
 * Each member's recents, stars and rail pins, keyed by email. Its own SQLite file beside the
 * index, not in it: the index is a cache that backups leave out and that may be deleted and
 * rebuilt from Git, and these lists can't be rebuilt from anything.
 */
export class AccountStore {
  readonly #db: Database.Database
  readonly #q: ReturnType<typeof prepare>

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = NORMAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#migrate()
    this.#q = prepare(this.#db)
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
        // Never lowered: a newer release may have migrated this file before a rollback.
        this.#db
          .prepare('UPDATE schema_version SET version = ?')
          .run(Math.max(current, MIGRATIONS.length))
      })
      .immediate()
  }

  /**
   * Copies the lists an older release kept in the index into this file, once. `read` is called
   * only the first time; later starts skip it, so an unstarred file never comes back from the
   * old copy. Rows already here win over the old copy. All or nothing.
   */
  copyFromIndexOnce(read: () => LegacyMemberLists): boolean {
    return this.#db
      .transaction(() => {
        if (this.#q.isDone.get(FROM_INDEX)) return false
        const old = read()
        for (const r of old.recents) this.#q.keepRecent.run(r.user, r.space, r.path, r.openedAt)
        for (const s of old.stars) this.#q.addStar.run(s.user, s.space, s.path)
        for (const p of old.pins) this.#q.keepPins.run(p.user, p.apps)
        this.#q.markDone.run(FROM_INDEX, new Date().toISOString())
        return true
      })
      .immediate()
  }

  touchRecent(user: string, space: string, path: string): void {
    this.#q.touchRecent.run(user, space, path, new Date().toISOString())
  }

  /** Most recent first. */
  listRecents(
    user: string,
    limit: number,
  ): Array<{ space: string; path: string; openedAt: string }> {
    return this.#q.listRecents.all(user, limit)
  }

  setStarred(user: string, space: string, path: string, starred: boolean): void {
    if (starred) this.#q.addStar.run(user, space, path)
    else this.#q.removeStar.run(user, space, path)
  }

  /** By space, then path. */
  listStars(user: string): Array<{ space: string; path: string }> {
    return this.#q.listStars.all(user)
  }

  /** The apps `user` pinned to their rail, in order; null until they first change them. */
  getPins(user: string): string[] | null {
    const row = this.#q.getPins.get(user)
    return row ? (JSON.parse(row.apps) as string[]) : null
  }

  setPins(user: string, apps: readonly string[]): void {
    this.#q.setPins.run(user, JSON.stringify(apps))
  }
}

function prepare(db: Database.Database) {
  return {
    isDone: db.prepare<[string], { name: string }>('SELECT name FROM done WHERE name = ?'),
    markDone: db.prepare<[string, string]>('INSERT OR IGNORE INTO done (name, at) VALUES (?, ?)'),

    touchRecent: db.prepare<[string, string, string, string]>(`
      INSERT INTO recents (user, space, path, opened_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user, space, path) DO UPDATE SET opened_at = excluded.opened_at`),
    // The copy from the index keeps whichever open is later.
    keepRecent: db.prepare<[string, string, string, string]>(`
      INSERT INTO recents (user, space, path, opened_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user, space, path) DO UPDATE SET opened_at = max(opened_at, excluded.opened_at)`),
    listRecents: db.prepare<[string, number], { space: string; path: string; openedAt: string }>(`
      SELECT space, path, opened_at AS openedAt FROM recents
      WHERE user = ? ORDER BY opened_at DESC LIMIT ?`),

    addStar: db.prepare<[string, string, string]>(
      'INSERT OR IGNORE INTO stars (user, space, path) VALUES (?, ?, ?)',
    ),
    removeStar: db.prepare<[string, string, string]>(
      'DELETE FROM stars WHERE user = ? AND space = ? AND path = ?',
    ),
    listStars: db.prepare<[string], { space: string; path: string }>(
      'SELECT space, path FROM stars WHERE user = ? ORDER BY space, path',
    ),

    getPins: db.prepare<[string], { apps: string }>('SELECT apps FROM pins WHERE user = ?'),
    setPins: db.prepare<[string, string]>(`
      INSERT INTO pins (user, apps) VALUES (?, ?)
      ON CONFLICT (user) DO UPDATE SET apps = excluded.apps`),
    // A member who already saved pins here keeps them over the old copy.
    keepPins: db.prepare<[string, string]>('INSERT OR IGNORE INTO pins (user, apps) VALUES (?, ?)'),
  }
}
