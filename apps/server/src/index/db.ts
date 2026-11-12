import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { extractDoc, type FileKind } from './extract.js'
import { toFtsAnyQuery, toFtsQuery } from './query.js'
import { migrate } from './schema.js'

export interface IndexFile {
  path: string
  content: string
  blobOid: string
}

/** The `mtime` of a file first seen in a full index: when it changed is unknown. */
export const NEVER_CHANGED = '1970-01-01T00:00:00.000Z'

export interface FileRow {
  space: string
  path: string
  id: string | null
  kind: FileKind
  title: string
  blobOid: string
  size: number
  mtime: string
  /** The parsed frontmatter, or null when the file has none (or it isn't a YAML mapping). */
  frontmatter: Record<string, unknown> | null
}

export interface SearchOptions {
  spaces: string[]
  limit?: number
  /** Only files of these kinds. */
  kinds?: FileKind[]
  /** Only paths starting with this string (give a folder with its trailing slash). */
  prefix?: string | undefined
  /** Match files containing any of the words, minus common stop words, instead of all of them. */
  anyTerm?: boolean
}

export interface ListFilesOptions {
  space: string
  kind?: FileKind | undefined
  /** Only paths starting with this string (give a folder with its trailing slash). */
  prefix?: string | undefined
  limit?: number
  /** `path` (default) ascending, or frontmatter `date` newest first, then path. */
  order?: 'path' | 'date_desc'
}

export interface SearchHit {
  space: string
  path: string
  title: string
  /** Body excerpt; matched terms are wrapped in SNIPPET_OPEN / SNIPPET_CLOSE. */
  snippet: string
  /** Higher is better (negated bm25). */
  score: number
}

export interface SpaceRecord {
  name: string
  kind: 'team' | 'personal'
  ownerEmail: string | null
  createdAt: string
}

/**
 * Control characters rather than `<mark>` so a snippet never carries markup: the client splits on
 * them and renders highlights as elements, and document text is always rendered as text.
 */
export const SNIPPET_OPEN = '\u0002'
export const SNIPPET_CLOSE = '\u0003'

const TITLE_WEIGHT = 4
const BODY_WEIGHT = 1
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export class Index {
  readonly #db: Database.Database
  readonly #q: ReturnType<typeof prepareStatements>

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = NORMAL')
    this.#db.pragma('busy_timeout = 5000')
    sqliteVec.load(this.#db)
    migrate(this.#db)
    this.#q = prepareStatements(this.#db)
  }

  close(): void {
    this.#db.close()
  }

  vecVersion(): string {
    return this.#q.vecVersion.get()?.v ?? ''
  }

  /**
   * Replaces everything indexed for `space`, atomically. A file whose content is unchanged keeps
   * its `mtime`, so a restart's reindex doesn't make every file look just changed.
   */
  reindexSpace(space: string, files: IndexFile[]): void {
    const keep = new Set(files.map((f) => f.path))
    this.#db.transaction(() => {
      const had = this.#q.spacePaths.all(space)
      // A space indexed for the first time (a new volume, a deleted index) has no idea when its
      // files last changed: they get the epoch, not "just now", so Today doesn't list them all.
      const mtime = had.length === 0 ? NEVER_CHANGED : new Date().toISOString()
      for (const { path } of had) if (!keep.has(path)) this.#q.deleteFile.run(space, path)
      for (const file of files) this.#q.upsertFile.run(toRow(space, file, mtime))
    })()
  }

  upsertFiles(space: string, files: IndexFile[]): void {
    const mtime = new Date().toISOString()
    this.#db.transaction(() => {
      for (const file of files) this.#q.upsertFile.run(toRow(space, file, mtime))
    })()
  }

  removeFiles(space: string, paths: string[]): void {
    this.#db.transaction(() => {
      for (const p of paths) this.#q.deleteFile.run(space, p)
    })()
  }

  getFile(space: string, path: string): FileRow | null {
    const row = this.#q.getFile.get(space, path)
    return row ? toFileRow(row) : null
  }

  /** Indexed files of one space; no limit unless given. */
  listFiles(opts: ListFilesOptions): FileRow[] {
    const limit = opts.limit === undefined ? -1 : Math.max(Math.trunc(opts.limit), 0)
    return this.#q.listFiles
      .all({
        space: opts.space,
        kind: opts.kind ?? null,
        prefix: opts.prefix ?? null,
        order: opts.order ?? 'path',
        limit,
      })
      .map(toFileRow)
  }

  /**
   * The indexed body (the text after the frontmatter) of each of `paths` in `space` that is
   * indexed, keyed by path. One query, so a list of tasks shows its notes without a Git read each.
   */
  bodies(space: string, paths: string[]): Map<string, string> {
    if (paths.length === 0) return new Map()
    const rows = this.#q.bodies.all({ space, paths: JSON.stringify(paths) })
    return new Map(rows.map((r) => [r.path, r.body]))
  }

  /** One file's indexed body and the line of the file it starts on, or null. */
  bodyAt(space: string, path: string): { body: string; line: number } | null {
    const row = this.#q.bodyAt.get(space, path)
    return row ? { body: row.body, line: row.bodyLine } : null
  }

  /** Full-text search limited to `spaces`. Any user string is safe; nothing searchable → []. */
  search(q: string, opts: SearchOptions): SearchHit[] {
    const match = opts.anyTerm ? toFtsAnyQuery(q) : toFtsQuery(q)
    if (match === null || opts.spaces.length === 0) return []
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
    return this.#q.search.all({
      match,
      spaces: JSON.stringify(opts.spaces),
      kinds: opts.kinds ? JSON.stringify(opts.kinds) : null,
      prefix: opts.prefix ?? null,
      limit,
    })
  }

  /**
   * Ranks short passages against a question with the same tokenizer and bm25 as `search`, any
   * word matching (`anyTerm`). Returns the indexes of matching passages, best first.
   */
  rankPassages(
    q: string,
    passages: string[],
    limit: number,
  ): Array<{ index: number; score: number }> {
    const match = toFtsAnyQuery(q)
    if (match === null || passages.length === 0) return []
    return this.#db.transaction(() => {
      passages.forEach((text, i) => {
        this.#q.addPassage.run(i + 1, text)
      })
      const ranked = this.#q.rankPassages.all({ match, limit: Math.max(Math.trunc(limit), 1) })
      this.#q.clearPassages.run()
      return ranked.map((r) => ({ index: r.rowid - 1, score: r.score }))
    })()
  }

  getSyncState(space: string): { headOid: string; syncedAt: string } | null {
    return this.#q.getSyncState.get(space) ?? null
  }

  setSyncState(space: string, headOid: string): void {
    this.#q.setSyncState.run(space, headOid, new Date().toISOString())
  }

  addConflict(space: string, ref: string, path: string): void {
    this.#q.addConflict.run(space, ref, path, new Date().toISOString())
  }

  removeConflict(space: string, ref: string): void {
    this.#q.removeConflict.run(space, ref)
  }

  listConflicts(space: string): Array<{ ref: string; path: string; createdAt: string }> {
    return this.#q.listConflicts.all(space)
  }

  touchRecent(user: string, space: string, path: string): void {
    this.#q.touchRecent.run(user, space, path, new Date().toISOString())
  }

  /** Most recent first; `title` is null when the file is no longer indexed. */
  listRecents(
    user: string,
    limit = DEFAULT_LIMIT,
  ): Array<{ space: string; path: string; title: string | null; openedAt: string }> {
    return this.#q.listRecents.all(user, limit)
  }

  setStarred(user: string, space: string, path: string, starred: boolean): void {
    if (starred) this.#q.addStar.run(user, space, path)
    else this.#q.removeStar.run(user, space, path)
  }

  listStars(user: string): Array<{ space: string; path: string; title: string | null }> {
    return this.#q.listStars.all(user)
  }

  getSpace(name: string): SpaceRecord | null {
    return this.#q.getSpace.get(name) ?? null
  }

  /** Inserts or updates; `createdAt` is kept from the first insert. */
  upsertSpace(space: Omit<SpaceRecord, 'createdAt'>): void {
    this.#q.upsertSpace.run({ ...space, createdAt: new Date().toISOString() })
  }

  listSpaces(): SpaceRecord[] {
    return this.#q.listSpaces.all()
  }
}

interface FileParams {
  space: string
  path: string
  id: string | null
  kind: FileKind
  title: string
  body: string
  blobOid: string
  size: number
  mtime: string
  frontmatter: string | null
  bodyLine: number
}

type RawFileRow = Omit<FileRow, 'frontmatter'> & { frontmatter: string | null }

function toFileRow(row: RawFileRow): FileRow {
  return { ...row, frontmatter: row.frontmatter === null ? null : JSON.parse(row.frontmatter) }
}

function toRow(space: string, file: IndexFile, mtime: string): FileParams {
  const doc = extractDoc(file.path, file.content)
  return {
    space,
    path: file.path,
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    body: doc.body,
    blobOid: file.blobOid,
    size: Buffer.byteLength(file.content),
    mtime,
    frontmatter: doc.frontmatter === null ? null : JSON.stringify(doc.frontmatter),
    bodyLine: doc.bodyLine,
  }
}

const FILE_COLUMNS = 'space, path, id, kind, title, blob_oid AS blobOid, size, mtime, frontmatter'

function prepareStatements(db: Database.Database) {
  // Scratch table for rankPassages. Temp tables belong to this connection and vanish with it.
  db.exec("CREATE VIRTUAL TABLE temp.passages USING fts5(text, tokenize = 'porter unicode61')")
  return {
    vecVersion: db.prepare<[], { v: string }>('SELECT vec_version() AS v'),

    upsertFile: db.prepare<FileParams>(`
      INSERT INTO files (space, path, id, kind, title, body, blob_oid, size, mtime, frontmatter, body_line)
      VALUES (@space, @path, @id, @kind, @title, @body, @blobOid, @size, @mtime, @frontmatter, @bodyLine)
      ON CONFLICT (space, path) DO UPDATE SET
        id = excluded.id, kind = excluded.kind, title = excluded.title, body = excluded.body,
        mtime = CASE WHEN files.blob_oid = excluded.blob_oid THEN files.mtime ELSE excluded.mtime END,
        blob_oid = excluded.blob_oid, size = excluded.size,
        frontmatter = excluded.frontmatter, body_line = excluded.body_line`),
    deleteFile: db.prepare<[string, string]>('DELETE FROM files WHERE space = ? AND path = ?'),
    deleteSpace: db.prepare<[string]>('DELETE FROM files WHERE space = ?'),
    spacePaths: db.prepare<[string], { path: string }>('SELECT path FROM files WHERE space = ?'),
    getFile: db.prepare<[string, string], RawFileRow>(
      `SELECT ${FILE_COLUMNS} FROM files WHERE space = ? AND path = ?`,
    ),
    listFiles: db.prepare<
      { space: string; kind: string | null; prefix: string | null; order: string; limit: number },
      RawFileRow
    >(`
      SELECT ${FILE_COLUMNS} FROM files
      WHERE space = @space
        AND (@kind IS NULL OR kind = @kind)
        AND (@prefix IS NULL OR substr(path, 1, length(@prefix)) = @prefix)
      ORDER BY CASE WHEN @order = 'date_desc' THEN json_extract(frontmatter, '$.date') END DESC,
        path
      LIMIT @limit`),

    bodyAt: db.prepare<[string, string], { body: string; bodyLine: number }>(
      'SELECT body, body_line AS bodyLine FROM files WHERE space = ? AND path = ?',
    ),
    bodies: db.prepare<{ space: string; paths: string }, { path: string; body: string }>(`
      SELECT path, body FROM files
      WHERE space = @space AND path IN (SELECT value FROM json_each(@paths))`),

    search: db.prepare<
      {
        match: string
        spaces: string
        kinds: string | null
        prefix: string | null
        limit: number
      },
      SearchHit
    >(`
      SELECT f.space, f.path, f.title,
        snippet(files_fts, 1, char(2), char(3), '…', 16) AS snippet,
        -bm25(files_fts, ${TITLE_WEIGHT}, ${BODY_WEIGHT}) AS score
      FROM files_fts JOIN files f ON f.rowid = files_fts.rowid
      WHERE files_fts MATCH @match
        AND f.space IN (SELECT value FROM json_each(@spaces))
        AND (@kinds IS NULL OR f.kind IN (SELECT value FROM json_each(@kinds)))
        AND (@prefix IS NULL OR substr(f.path, 1, length(@prefix)) = @prefix)
      ORDER BY score DESC, f.space, f.path
      LIMIT @limit`),

    addPassage: db.prepare<[number, string]>(
      'INSERT INTO temp.passages (rowid, text) VALUES (?, ?)',
    ),
    rankPassages: db.prepare<{ match: string; limit: number }, { rowid: number; score: number }>(`
      SELECT rowid, -bm25(passages) AS score FROM temp.passages
      WHERE passages MATCH @match
      ORDER BY score DESC, rowid
      LIMIT @limit`),
    clearPassages: db.prepare('DELETE FROM temp.passages'),

    getSyncState: db.prepare<[string], { headOid: string; syncedAt: string }>(
      'SELECT head_oid AS headOid, synced_at AS syncedAt FROM sync_state WHERE space = ?',
    ),
    setSyncState: db.prepare<[string, string, string]>(`
      INSERT INTO sync_state (space, head_oid, synced_at) VALUES (?, ?, ?)
      ON CONFLICT (space) DO UPDATE SET head_oid = excluded.head_oid, synced_at = excluded.synced_at`),

    addConflict: db.prepare<[string, string, string, string]>(
      'INSERT OR IGNORE INTO conflicts (space, ref, path, created_at) VALUES (?, ?, ?, ?)',
    ),
    removeConflict: db.prepare<[string, string]>(
      'DELETE FROM conflicts WHERE space = ? AND ref = ?',
    ),
    listConflicts: db.prepare<[string], { ref: string; path: string; createdAt: string }>(
      'SELECT ref, path, created_at AS createdAt FROM conflicts WHERE space = ? ORDER BY created_at, ref',
    ),

    touchRecent: db.prepare<[string, string, string, string]>(`
      INSERT INTO recents (user, space, path, opened_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user, space, path) DO UPDATE SET opened_at = excluded.opened_at`),
    listRecents: db.prepare<
      [string, number],
      { space: string; path: string; title: string | null; openedAt: string }
    >(`
      SELECT r.space, r.path, f.title, r.opened_at AS openedAt
      FROM recents r LEFT JOIN files f ON f.space = r.space AND f.path = r.path
      WHERE r.user = ? ORDER BY r.opened_at DESC LIMIT ?`),

    addStar: db.prepare<[string, string, string]>(
      'INSERT OR IGNORE INTO stars (user, space, path) VALUES (?, ?, ?)',
    ),
    removeStar: db.prepare<[string, string, string]>(
      'DELETE FROM stars WHERE user = ? AND space = ? AND path = ?',
    ),
    listStars: db.prepare<[string], { space: string; path: string; title: string | null }>(`
      SELECT s.space, s.path, f.title
      FROM stars s LEFT JOIN files f ON f.space = s.space AND f.path = s.path
      WHERE s.user = ? ORDER BY s.space, s.path`),

    getSpace: db.prepare<[string], SpaceRecord>(`
      SELECT name, kind, owner_email AS ownerEmail, created_at AS createdAt
      FROM spaces WHERE name = ?`),
    upsertSpace: db.prepare<SpaceRecord>(`
      INSERT INTO spaces (name, kind, owner_email, created_at)
      VALUES (@name, @kind, @ownerEmail, @createdAt)
      ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, owner_email = excluded.owner_email`),
    listSpaces: db.prepare<[], SpaceRecord>(`
      SELECT name, kind, owner_email AS ownerEmail, created_at AS createdAt
      FROM spaces ORDER BY name`),
  }
}
