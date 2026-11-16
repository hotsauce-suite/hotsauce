import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  DictationStore,
  deviceTokenFrom,
  hashDeviceToken,
  macAppVersionFrom,
  newDeviceToken,
  normalizeWords,
  TEAM_WORDS_SEED,
} from './store.js'

const ALICE = { userId: 'u_alice', email: 'alice@example.test' }

describe('device tokens', () => {
  it('are hdt_ plus 43 url-safe characters, different every time', () => {
    const a = newDeviceToken()
    expect(a).toMatch(/^hdt_[A-Za-z0-9_-]{43}$/)
    expect(newDeviceToken()).not.toBe(a)
  })

  it('hash to sha256 hex', () => {
    expect(hashDeviceToken('hdt_x')).toBe(
      '06daa48a9156d72da1ef0c4cc84c4e49f611308b684936f805356480b9cac28f',
    )
    expect(hashDeviceToken('hdt_x')).not.toBe(hashDeviceToken('hdt_y'))
  })

  it('read a Mac app version only from a plain mac/X.Y.Z header', () => {
    expect(macAppVersionFrom('mac/0.26.0')).toBe('0.26.0')
    expect(macAppVersionFrom(' mac/1.2.3 ')).toBe('1.2.3')
    expect(macAppVersionFrom('mac/0.26')).toBeNull()
    expect(macAppVersionFrom('mac/0.26.0<script>')).toBeNull()
    expect(macAppVersionFrom('windows/0.26.0')).toBeNull()
    expect(macAppVersionFrom(undefined)).toBeNull()
  })

  it('are recognised only as a Bearer hdt_ header', () => {
    expect(deviceTokenFrom('Bearer hdt_abc-_1')).toBe('hdt_abc-_1')
    expect(deviceTokenFrom('bearer hdt_abc')).toBeNull()
    expect(deviceTokenFrom('Bearer eyJhbGciOi.x.y')).toBeNull()
    expect(deviceTokenFrom('Token hdt_abc')).toBeNull()
    expect(deviceTokenFrom(null)).toBeNull()
  })
})

describe('DictationStore', () => {
  it('keeps only the hash, finds the device by token, and stamps its use', () => {
    const store = new DictationStore(':memory:')
    const { device, token } = store.createDevice(ALICE, 'Ada’s MacBook')
    expect(device.lastUsedAt).toBeNull()
    const used = store.useToken(token, new Date('2026-11-09T12:00:00Z'))
    expect(used).toMatchObject({
      id: device.id,
      email: ALICE.email,
      lastUsedAt: '2026-11-09T12:00:00.000Z',
    })
    expect(store.listDevices(ALICE.userId)[0]?.lastUsedAt).toBe('2026-11-09T12:00:00.000Z')
    expect(store.useToken(`${token}x`)).toBeNull()
  })

  it('revokes a member’s own device only', () => {
    const store = new DictationStore(':memory:')
    const { device, token } = store.createDevice(ALICE, 'Mac')
    expect(() => store.revokeDevice('u_bob', device.id)).toThrow(/No such device/)
    store.revokeDevice(ALICE.userId, device.id)
    expect(store.useToken(token)).toBeNull()
    expect(store.listDevices(ALICE.userId)).toEqual([])
    expect(() => store.revokeDevice(ALICE.userId, device.id)).toThrow(/No such device/)
  })

  it('keeps a member’s devices when their email changes', () => {
    const store = new DictationStore(':memory:')
    store.createDevice(ALICE, 'Mac')
    expect(store.listDevices(ALICE.userId)).toHaveLength(1)
    expect(store.listDevices(ALICE.email)).toHaveLength(0)
  })

  it('keeps the Mac app version a device reports, and the last one when it reports none', () => {
    const store = new DictationStore(':memory:')
    const { token } = store.createDevice(ALICE, 'Mac')
    expect(store.listDevices(ALICE.userId)[0]?.appVersion).toBeNull()
    expect(store.useToken(token, new Date(), '0.26.0')?.appVersion).toBe('0.26.0')
    store.useToken(token)
    expect(store.listDevices(ALICE.userId)[0]?.appVersion).toBe('0.26.0')
    store.useToken(token, new Date(), '0.27.1')
    expect(store.listDevices(ALICE.userId)[0]?.appVersion).toBe('0.27.1')
  })

  it('adds the version column to a file made before it, keeping its devices', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-dict-')), 'dictation.sqlite')
    const old = new Database(file)
    old.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      CREATE TABLE dictation_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        last_used_at TEXT, revoked_at TEXT);
      CREATE TABLE dictation_words (scope TEXT NOT NULL, word TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (scope, word));`)
    old
      .prepare('INSERT INTO dictation_devices VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
      .run('d1', ALICE.userId, ALICE.email, 'Mac', hashDeviceToken('hdt_x'), '2026-11-01T00:00:00Z')
    old.close()
    const store = new DictationStore(file)
    expect(store.listDevices(ALICE.userId)).toMatchObject([{ id: 'd1', appVersion: null }])
    expect(store.useToken('hdt_x', new Date(), '0.26.0')?.appVersion).toBe('0.26.0')
    store.close()
  })

  it('revokes every device of a user', () => {
    const store = new DictationStore(':memory:')
    const a = store.createDevice(ALICE, 'one').token
    const b = store.createDevice(ALICE, 'two').token
    store.revokeAllForUser(ALICE.userId)
    expect(store.useToken(a)).toBeNull()
    expect(store.useToken(b)).toBeNull()
  })

  it('seeds the team words once and keeps each list in order', () => {
    const store = new DictationStore(':memory:')
    expect(store.words('team')).toEqual(TEAM_WORDS_SEED)
    expect(store.setWords(ALICE.userId, [' Zeta ', 'alpha', 'ZETA', ''])).toEqual(['Zeta', 'alpha'])
    expect(store.words(ALICE.userId)).toEqual(['Zeta', 'alpha'])
    expect(store.words('bob@example.test')).toEqual([])
  })

  it('refuses an over-long list', () => {
    const store = new DictationStore(':memory:')
    expect(() =>
      store.setWords(
        'team',
        Array.from({ length: 201 }, (_, i) => `w${i}`),
      ),
    ).toThrow(/at most 200/)
  })
})

describe('normalizeWords', () => {
  it('collapses spaces and drops case-insensitive repeats', () => {
    expect(normalizeWords(['Acme  Bio', 'acme bio', 'Clerk'])).toEqual(['Acme Bio', 'Clerk'])
  })
})

describe('DictationStore after a rollback', () => {
  // A release that added a migration ran, then the updater put the previous release back. The
  // older build must leave the version alone, or the next update runs that migration twice.
  it('opens a database a newer release migrated without lowering its version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsauce-dictation-'))
    try {
      const file = path.join(dir, 'dictation.sqlite')
      const first = new DictationStore(file)
      const { token } = first.createDevice(ALICE, 'Ada’s MacBook')
      first.close()

      const raw = new Database(file)
      const { version } = raw.prepare('SELECT version FROM schema_version').get() as {
        version: number
      }
      raw.exec('CREATE TABLE added_by_a_newer_release (id TEXT)')
      raw.prepare('UPDATE schema_version SET version = ?').run(version + 1)
      raw.close()

      const older = new DictationStore(file)
      expect(older.useToken(token, new Date('2026-11-16T12:00:00Z'))?.email).toBe(ALICE.email)
      older.close()

      const check = new Database(file)
      expect(check.prepare('SELECT version FROM schema_version').get()).toEqual({
        version: version + 1,
      })
      check.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
