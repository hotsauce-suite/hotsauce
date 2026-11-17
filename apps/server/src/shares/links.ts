import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'

/**
 * Who a read-only link is for and when it ends (docs/PLAN-outside-links.md). The token itself
 * stays where it always was (a file's frontmatter); this holds what Git doesn't need to. A token
 * without a row is a link from before: for signed-in people only, never ending, so a lost row
 * fails safe.
 */

export type LinkKind = 'doc' | 'meeting' | 'note' | 'page' | 'clip' | 'file'

/** What a link points at: a path in a space, a clip, or a Files item. */
export type LinkRef =
  | { space: string; path: string }
  | { clip: string }
  | { space: string; id: string }

export interface LinkRecord {
  token: string
  kind: LinkKind
  ref: LinkRef
  anyone: boolean
  /** When it stops opening (ISO), or null for never. */
  expiresAt: string | null
  title: string
  createdBy: { name: string; email: string }
  createdAt: string
}

/** What the Share menu needs to know about a link. */
export interface LinkPolicy {
  anyone: boolean
  expiresAt: string | null
  ended: boolean
}

export const EXPIRY_DAYS = [7, 30, 0] as const
export type ExpiryDays = (typeof EXPIRY_DAYS)[number]
export const DEFAULT_EXPIRY_DAYS: ExpiryDays = 30

/** The choices made when a link is turned on. */
export interface LinkOptions {
  anyone?: boolean
  /** 7, 30 or 0 (never). Default 30. */
  expiresDays?: ExpiryDays
}

const MIGRATIONS = [
  `CREATE TABLE links (
     token TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     ref TEXT NOT NULL,
     ref_key TEXT NOT NULL,
     anyone INTEGER NOT NULL,
     expires_at TEXT,
     title TEXT NOT NULL,
     created_by_name TEXT NOT NULL,
     created_by_email TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX links_ref ON links (ref_key);`,
]

interface Row {
  token: string
  kind: LinkKind
  ref: string
  anyone: number
  expires_at: string | null
  title: string
  created_by_name: string
  created_by_email: string
  created_at: string
}

export const refKey = (ref: LinkRef): string =>
  'clip' in ref
    ? `clip:${ref.clip}`
    : 'id' in ref
      ? `file:${ref.space}:${ref.id}`
      : `path:${ref.space}:${ref.path}`

export class LinkStore {
  readonly #db: Database.Database
  readonly #now: () => Date

  constructor(file: string, opts: { now?: () => Date } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#now = opts.now ?? (() => new Date(Date.now()))
    this.#db.transaction(() => {
      this.#db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
      const row = this.#db.prepare('SELECT version FROM schema_version').get() as
        | { version: number }
        | undefined
      if (!row) this.#db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
      for (const sql of MIGRATIONS.slice(row?.version ?? 0)) this.#db.exec(sql)
      this.#db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length)
    })()
  }

  close(): void {
    this.#db.close()
  }

  /** Records a link that was just turned on. */
  create(
    principal: Principal,
    link: { token: string; kind: LinkKind; ref: LinkRef; title: string },
    opts: LinkOptions,
    allowAnyone: boolean,
  ): LinkRecord {
    checkLinkOptions(opts, allowAnyone)
    const anyone = opts.anyone === true
    const days = opts.expiresDays ?? DEFAULT_EXPIRY_DAYS
    const now = this.#now()
    const record: LinkRecord = {
      ...link,
      anyone,
      expiresAt: days === 0 ? null : new Date(now.getTime() + days * 86_400_000).toISOString(),
      createdBy: { name: principal.name, email: principal.email },
      createdAt: now.toISOString(),
    }
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO links (token, kind, ref, ref_key, anyone, expires_at, title,
           created_by_name, created_by_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.token,
        record.kind,
        JSON.stringify(record.ref),
        refKey(record.ref),
        anyone ? 1 : 0,
        record.expiresAt,
        record.title.slice(0, 300),
        record.createdBy.name,
        record.createdBy.email,
        record.createdAt,
      )
    return record
  }

  get(token: string): LinkRecord | null {
    const row = this.#db.prepare('SELECT * FROM links WHERE token = ?').get(token) as
      | Row
      | undefined
    return row ? fromRow(row) : null
  }

  /** The newest link recorded for a thing (a clip has no frontmatter to hold its token). */
  forRef(ref: LinkRef): LinkRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM links WHERE ref_key = ? ORDER BY created_at DESC LIMIT 1')
      .get(refKey(ref)) as Row | undefined
    return row ? fromRow(row) : null
  }

  /** How a token behaves: a token without a row is a link from before (members, never ends). */
  policy(token: string | null): LinkPolicy | null {
    if (!token) return null
    const row = this.get(token)
    if (!row) return { anyone: false, expiresAt: null, ended: false }
    return { anyone: row.anyone, expiresAt: row.expiresAt, ended: this.ended(row) }
  }

  ended(row: Pick<LinkRecord, 'expiresAt'>): boolean {
    return row.expiresAt !== null && Date.parse(row.expiresAt) <= this.#now().getTime()
  }

  /** Every recorded link, newest first. */
  list(): LinkRecord[] {
    return (this.#db.prepare('SELECT * FROM links ORDER BY created_at DESC').all() as Row[]).map(
      fromRow,
    )
  }

  /** Ends a link now (Settings → Turn off); the item's Share then offers a fresh one. */
  end(token: string): LinkRecord | null {
    const row = this.get(token)
    if (!row) return null
    if (this.ended(row)) return row
    const now = this.#now().toISOString()
    this.#db.prepare('UPDATE links SET expires_at = ? WHERE token = ?').run(now, token)
    return { ...row, expiresAt: now }
  }

  delete(token: string): void {
    this.#db.prepare('DELETE FROM links WHERE token = ?').run(token)
  }

  deleteRef(ref: LinkRef): void {
    this.#db.prepare('DELETE FROM links WHERE ref_key = ?').run(refKey(ref))
  }
}

/** Refuses an "anyone" link the organization doesn't allow, and an end date we don't offer. */
export function checkLinkOptions(opts: LinkOptions, allowAnyone: boolean): void {
  if (opts.anyone === true && !allowAnyone) throw anyoneOff()
  const days = opts.expiresDays ?? DEFAULT_EXPIRY_DAYS
  if (!(EXPIRY_DAYS as readonly number[]).includes(days)) {
    throw new HotsauceError('bad_request', 'A link ends after 7 days, 30 days, or never')
  }
}

function fromRow(row: Row): LinkRecord {
  return {
    token: row.token,
    kind: row.kind,
    ref: JSON.parse(row.ref) as LinkRef,
    anyone: row.anyone === 1,
    expiresAt: row.expires_at,
    title: row.title,
    createdBy: { name: row.created_by_name, email: row.created_by_email },
    createdAt: row.created_at,
  }
}

export const anyoneOff = () =>
  new HotsauceError(
    'bad_request',
    'Links anyone can open are turned off for this organization. An admin can turn them on in Settings → Organization.',
  )

export const linkEnded = () =>
  new HotsauceError('not_found', 'This link has ended. Ask whoever sent it for a new one.', {
    status: 410,
  })
