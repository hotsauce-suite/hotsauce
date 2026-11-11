import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ulid } from 'ulid'
import { HearthError } from '../errors.js'

/** A Mac connected to Hearth Dictate. The token itself is never stored, only its hash. */
export interface DictationDevice {
  id: string
  userId: string
  email: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export const DEVICE_TOKEN_PREFIX = 'hdt_'
// A new organization's team word list starts with the tools' own names; admins add theirs.
export const TEAM_WORDS_SEED = ['Hotsauce', 'Clerk', 'Deepgram', 'Anthropic', 'Claude']
export const MAX_WORDS_PER_LIST = 200
export const MAX_WORD_LENGTH = 60
const MAX_DEVICES_PER_MEMBER = 20

export function newDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Whether a request's Authorization header carries a device token (not a Clerk session). */
export function deviceTokenFrom(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(hdt_[A-Za-z0-9_-]+)\s*$/.exec(authorization ?? '')
  return match ? (match[1] ?? null) : null
}

/** Trimmed, deduplicated case-insensitively (first spelling wins), in the given order. */
export function normalizeWords(words: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    const word = w.replace(/\s+/g, ' ').trim()
    const key = word.toLowerCase()
    if (word === '' || seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

const MIGRATIONS = [
  `
  CREATE TABLE dictation_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX dictation_devices_user ON dictation_devices (user_id);
  CREATE TABLE dictation_words (
    scope TEXT NOT NULL,            -- 'team' or a member's user id
    word TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (scope, word)
  );
  `,
]

interface DeviceRow {
  id: string
  user_id: string
  email: string
  name: string
  created_at: string
  last_used_at: string | null
}

/**
 * Device tokens and dictionaries. Its own SQLite file beside the index, not in it: the index is
 * a cache that may be deleted and rebuilt from Git, and this is device state that can't be.
 */
export class DictationStore {
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
        if (current === 0) this.#setWords('team', TEAM_WORDS_SEED)
        this.#db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length)
      })
      .immediate()
  }

  /** A new device for the member; the token is returned once and only its hash is kept. */
  createDevice(
    member: { userId: string; email: string },
    name: string,
  ): { device: DictationDevice; token: string } {
    const active = this.listDevices(member.userId)
    if (active.length >= MAX_DEVICES_PER_MEMBER) {
      throw new HearthError(
        'bad_request',
        `You have ${active.length} connected devices; revoke one first`,
      )
    }
    const token = newDeviceToken()
    const device: DictationDevice = {
      id: ulid(),
      userId: member.userId,
      email: member.email,
      name,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    this.#db
      .prepare(
        'INSERT INTO dictation_devices (id, user_id, email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        device.id,
        device.userId,
        device.email,
        device.name,
        hashDeviceToken(token),
        device.createdAt,
      )
    return { device, token }
  }

  /** A member's live devices, by user id: an email can change, the account can't. */
  listDevices(userId: string): DictationDevice[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM dictation_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .all(userId) as DeviceRow[]
    return rows.map(toDevice)
  }

  /** The live device a token belongs to, marking it used; null for an unknown or revoked token. */
  useToken(token: string, now = new Date()): DictationDevice | null {
    const row = this.#db
      .prepare('SELECT * FROM dictation_devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hashDeviceToken(token)) as DeviceRow | undefined
    if (!row) return null
    const lastUsedAt = now.toISOString()
    this.#db
      .prepare('UPDATE dictation_devices SET last_used_at = ? WHERE id = ?')
      .run(lastUsedAt, row.id)
    return { ...toDevice(row), lastUsedAt }
  }

  /** Revokes one of the member's own devices; not_found for anyone else's. */
  revokeDevice(userId: string, id: string): void {
    const result = this.#db
      .prepare(
        'UPDATE dictation_devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), id, userId)
    if (result.changes === 0) throw new HearthError('not_found', 'No such device')
  }

  /** Every device of a user who may no longer use Hearth. */
  revokeAllForUser(userId: string): void {
    this.#db
      .prepare(
        'UPDATE dictation_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), userId)
  }

  /** `scope` is 'team' or a member's user id. */
  words(scope: 'team' | string): string[] {
    const rows = this.#db
      .prepare('SELECT word FROM dictation_words WHERE scope = ? ORDER BY position')
      .all(scope) as Array<{ word: string }>
    return rows.map((r) => r.word)
  }

  setWords(scope: 'team' | string, words: readonly string[]): string[] {
    return this.#db.transaction(() => this.#setWords(scope, words))()
  }

  /**
   * Adds and removes words against the list as it is now, in one transaction, so two people
   * editing the team list at once (or one person adding twice quickly) never lose each other's words.
   */
  editWords(
    scope: 'team' | string,
    edit: { add?: readonly string[] | undefined; remove?: readonly string[] | undefined },
  ): string[] {
    return this.#db.transaction(() => {
      const removing = new Set((edit.remove ?? []).map((w) => w.trim().toLowerCase()))
      const kept = this.words(scope).filter((w) => !removing.has(w.toLowerCase()))
      return this.#setWords(scope, [...kept, ...(edit.add ?? [])])
    })()
  }

  #setWords(scope: string, words: readonly string[]): string[] {
    const list = normalizeWords(words)
    if (list.length > MAX_WORDS_PER_LIST) {
      throw new HearthError('bad_request', `A word list holds at most ${MAX_WORDS_PER_LIST} words`)
    }
    this.#db.prepare('DELETE FROM dictation_words WHERE scope = ?').run(scope)
    const insert = this.#db.prepare(
      'INSERT INTO dictation_words (scope, word, position) VALUES (?, ?, ?)',
    )
    for (const [i, word] of list.entries()) insert.run(scope, word, i)
    return list
  }
}

function toDevice(row: DeviceRow): DictationDevice {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}
