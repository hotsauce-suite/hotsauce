import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ulid } from 'ulid'
import { HotsauceError } from '../errors.js'

/** A Mac connected to Hotsauce Dictate. The token itself is never stored, only its hash. */
export interface DictationDevice {
  id: string
  userId: string
  email: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  /** The Mac app version this device last reported (`Hotsauce-App: mac/<version>`), or null. */
  appVersion: string | null
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
  // The app version each device reports (docs/PLAN-mac-version-and-whats-new.md, M3).
  `ALTER TABLE dictation_devices ADD COLUMN app_version TEXT;`,
  // Each member's cleanup choice (docs/PLAN-dictate-models.md, R4); no row means Fast.
  `CREATE TABLE dictation_prefs (
    user_id TEXT PRIMARY KEY,
    cleanup TEXT NOT NULL
  );`,
  // Where the Mac app hears the member (docs/PLAN-dictate-models.md, R7); null is online.
  `ALTER TABLE dictation_prefs ADD COLUMN speech TEXT;`,
  // The send key and the sounds (docs/PLAN-dictate-send-and-sounds.md, R1); null is the default.
  `ALTER TABLE dictation_prefs ADD COLUMN send_key TEXT;
   ALTER TABLE dictation_prefs ADD COLUMN sounds TEXT;`,
]

/** How a member's dictations are cleaned up (docs/PLAN-dictate-models.md). */
export const CLEANUP_CHOICES = ['fast', 'careful', 'off'] as const
export type CleanupChoice = (typeof CLEANUP_CHOICES)[number]

/** Where the Mac app hears the member: the server's speech model, or the Mac alone. */
export const SPEECH_CHOICES = ['online', 'device'] as const
export type SpeechChoice = (typeof SPEECH_CHOICES)[number]

/** The key that ends a dictation and sends it (docs/PLAN-dictate-send-and-sounds.md). */
export const SEND_KEYS = ['space', 'return', 'tab', 'off'] as const
export type SendKey = (typeof SEND_KEYS)[number]

/** The sounds Dictate plays as it starts, stops, sends and cancels. */
export const SOUND_THEMES = ['soft', 'pop', 'click', 'chime', 'off'] as const
export type SoundTheme = (typeof SOUND_THEMES)[number]

/**
 * The version in a `Hotsauce-App: mac/<version>[+<build>]` header (`mac/0.26.0+1400`), or null
 * for anything else. Only a plain dotted number and a numeric build are kept, so nothing odd is
 * ever stored or shown. The build tells two Mac builds of one release apart.
 */
export function macAppVersionFrom(header: string | null | undefined): string | null {
  const match = /^mac\/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:\+\d{1,9})?)$/.exec((header ?? '').trim())
  return match ? (match[1] ?? null) : null
}

interface DeviceRow {
  id: string
  user_id: string
  email: string
  name: string
  created_at: string
  last_used_at: string | null
  app_version: string | null
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
        // Never lowered: a newer release may have migrated this file before a rollback, and
        // it must not run those migrations again when it returns.
        this.#db
          .prepare('UPDATE schema_version SET version = ?')
          .run(Math.max(current, MIGRATIONS.length))
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
      throw new HotsauceError(
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
      appVersion: null,
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

  /** When each connected (not revoked) device was last used, for the usage report; nothing else. */
  deviceLastUses(): Array<{ lastUsedAt: string | null }> {
    return this.#db
      .prepare('SELECT last_used_at AS lastUsedAt FROM dictation_devices WHERE revoked_at IS NULL')
      .all() as Array<{ lastUsedAt: string | null }>
  }

  /**
   * The live device a token belongs to, marking it used and keeping the app version it reports
   * (a request without one leaves the last one); null for an unknown or revoked token.
   */
  useToken(
    token: string,
    now = new Date(),
    appVersion: string | null = null,
  ): DictationDevice | null {
    const row = this.#db
      .prepare('SELECT * FROM dictation_devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hashDeviceToken(token)) as DeviceRow | undefined
    if (!row) return null
    const lastUsedAt = now.toISOString()
    const version = appVersion ?? row.app_version
    this.#db
      .prepare('UPDATE dictation_devices SET last_used_at = ?, app_version = ? WHERE id = ?')
      .run(lastUsedAt, version, row.id)
    return { ...toDevice(row), lastUsedAt, appVersion: version }
  }

  /** Revokes one of the member's own devices; not_found for anyone else's. */
  revokeDevice(userId: string, id: string): void {
    const result = this.#db
      .prepare(
        'UPDATE dictation_devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), id, userId)
    if (result.changes === 0) throw new HotsauceError('not_found', 'No such device')
  }

  /** Every device of a user who may no longer use Hotsauce. */
  revokeAllForUser(userId: string): void {
    this.#db
      .prepare(
        'UPDATE dictation_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), userId)
  }

  /** The member's cleanup choice; Fast until they pick another. */
  cleanupChoice(userId: string): CleanupChoice {
    const row = this.#db
      .prepare('SELECT cleanup FROM dictation_prefs WHERE user_id = ?')
      .get(userId) as { cleanup: string } | undefined
    const saved = row?.cleanup as CleanupChoice | undefined
    return saved && CLEANUP_CHOICES.includes(saved) ? saved : 'fast'
  }

  /** Where the member's Mac app hears them; online until they pick the Mac alone. */
  speechChoice(userId: string): SpeechChoice {
    const row = this.#db
      .prepare('SELECT speech FROM dictation_prefs WHERE user_id = ?')
      .get(userId) as { speech: string | null } | undefined
    return row?.speech === 'device' ? 'device' : 'online'
  }

  setSpeechChoice(userId: string, speech: SpeechChoice): void {
    this.#db
      .prepare(
        "INSERT INTO dictation_prefs (user_id, cleanup, speech) VALUES (?, 'fast', ?) ON CONFLICT (user_id) DO UPDATE SET speech = excluded.speech",
      )
      .run(userId, speech)
  }

  /** The member's send key; Space until they pick another. */
  sendKey(userId: string): SendKey {
    const row = this.#db
      .prepare('SELECT send_key FROM dictation_prefs WHERE user_id = ?')
      .get(userId) as { send_key: string | null } | undefined
    const saved = row?.send_key as SendKey | undefined
    return saved && SEND_KEYS.includes(saved) ? saved : 'space'
  }

  setSendKey(userId: string, sendKey: SendKey): void {
    this.#db
      .prepare(
        "INSERT INTO dictation_prefs (user_id, cleanup, send_key) VALUES (?, 'fast', ?) ON CONFLICT (user_id) DO UPDATE SET send_key = excluded.send_key",
      )
      .run(userId, sendKey)
  }

  /** The member's sounds; Soft until they pick another. */
  soundTheme(userId: string): SoundTheme {
    const row = this.#db
      .prepare('SELECT sounds FROM dictation_prefs WHERE user_id = ?')
      .get(userId) as { sounds: string | null } | undefined
    const saved = row?.sounds as SoundTheme | undefined
    return saved && SOUND_THEMES.includes(saved) ? saved : 'soft'
  }

  setSoundTheme(userId: string, sounds: SoundTheme): void {
    this.#db
      .prepare(
        "INSERT INTO dictation_prefs (user_id, cleanup, sounds) VALUES (?, 'fast', ?) ON CONFLICT (user_id) DO UPDATE SET sounds = excluded.sounds",
      )
      .run(userId, sounds)
  }

  setCleanupChoice(userId: string, cleanup: CleanupChoice): void {
    this.#db
      .prepare(
        'INSERT INTO dictation_prefs (user_id, cleanup) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET cleanup = excluded.cleanup',
      )
      .run(userId, cleanup)
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
      throw new HotsauceError(
        'bad_request',
        `A word list holds at most ${MAX_WORDS_PER_LIST} words`,
      )
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
    appVersion: row.app_version ?? null,
  }
}
