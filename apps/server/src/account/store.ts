import { createHash } from 'node:crypto'
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

  -- Small facts about this file, by name: the fingerprint of the index's old tables when they
  -- were last copied (AccountStore.syncFromIndex).
  CREATE TABLE meta (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Apps added once to every member's rail (comments plan R13): a member who already arranged
  -- their pins gets each one a single time; unpinned afterwards, it stays unpinned.
  CREATE TABLE pin_offers (
    user TEXT NOT NULL,
    app  TEXT NOT NULL,
    PRIMARY KEY (user, app)
  );
  `,
]

const INDEX_PRINT = 'index-lists-fingerprint'

/** What syncFromIndex did. */
export type SyncResult = 'copied' | 'unchanged' | 'replaced'

function fingerprint(lists: LegacyMemberLists): string {
  return createHash('sha256').update(JSON.stringify(lists)).digest('hex')
}

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
   * Brings in the lists an older release keeps in the index's old tables. `read` must list rows in
   * a stable order. All or nothing, in one IMMEDIATE transaction.
   *
   * - First start with this store: copies them, keeping any row already here.
   * - Old tables unchanged since then: nothing, so an unstar here never comes back from them.
   * - Old tables changed: an older release ran after this one (a rollback) and members used it,
   *   so its lists replace these. Empty old tables are a rebuilt index, not a member's choice,
   *   and are ignored.
   */
  syncFromIndex(read: () => LegacyMemberLists): SyncResult {
    return this.#db
      .transaction((): SyncResult => {
        const old = read()
        const print = fingerprint(old)
        const seen = this.#q.getMeta.get(INDEX_PRINT)?.value
        if (seen === print) return 'unchanged'
        const empty = old.recents.length + old.stars.length + old.pins.length === 0
        if (seen !== undefined && empty) return 'unchanged'
        if (seen !== undefined) {
          this.#q.clearRecents.run()
          this.#q.clearStars.run()
          this.#q.clearPins.run()
        }
        for (const r of old.recents) this.#q.keepRecent.run(r.user, r.space, r.path, r.openedAt)
        for (const s of old.stars) this.#q.addStar.run(s.user, s.space, s.path)
        for (const p of old.pins) this.#q.keepPins.run(p.user, p.apps)
        this.#q.setMeta.run(INDEX_PRINT, print)
        return seen === undefined ? 'copied' : 'replaced'
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

  /**
   * The member's pins with each of `offers` added once, right after the app it names (first when
   * that isn't pinned): a member still on the defaults already has them, and an offer made once is
   * never made again. Null, like `getPins`, until they first change their pins.
   */
  pinsWithOffers(
    user: string,
    offers: ReadonlyArray<{ app: string; after: string }>,
  ): string[] | null {
    return this.#db
      .transaction((): string[] | null => {
        const pins = this.getPins(user)
        const fresh = offers.filter((o) => !this.#q.hasOffer.get(user, o.app))
        if (fresh.length === 0) return pins
        for (const o of fresh) this.#q.addOffer.run(user, o.app)
        if (pins === null) return null
        const next = [...pins]
        for (const o of fresh) {
          if (next.includes(o.app)) continue
          next.splice(next.indexOf(o.after) + 1, 0, o.app)
        }
        this.setPins(user, next)
        return next
      })
      .immediate()
  }

  /** Records `apps` as offered to `user`: they arranged their rail with these on offer. */
  markOffered(user: string, apps: readonly string[]): void {
    for (const app of apps) this.#q.addOffer.run(user, app)
  }
}

function prepare(db: Database.Database) {
  return {
    getMeta: db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE name = ?'),
    setMeta: db.prepare<[string, string]>(`
      INSERT INTO meta (name, value) VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value`),
    clearRecents: db.prepare('DELETE FROM recents'),
    clearStars: db.prepare('DELETE FROM stars'),
    clearPins: db.prepare('DELETE FROM pins'),

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
    hasOffer: db.prepare<[string, string], { app: string }>(
      'SELECT app FROM pin_offers WHERE user = ? AND app = ?',
    ),
    addOffer: db.prepare<[string, string]>(
      'INSERT OR IGNORE INTO pin_offers (user, app) VALUES (?, ?)',
    ),
    // A member who already saved pins here keeps them over the old copy.
    keepPins: db.prepare<[string, string]>('INSERT OR IGNORE INTO pins (user, apps) VALUES (?, ?)'),
  }
}
